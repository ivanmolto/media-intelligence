// Boolean search against the seeded media_test database (plan §3, phase 2).
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { testDatabaseUrl } from "./db-url";

const db = new Pool({ connectionString: testDatabaseUrl() });
afterAll(() => db.end());

const CONFIGS = ["english", "simple"] as const;
type Config = (typeof CONFIGS)[number];

// The three leaf expressions of spec §2, "Compilation". The config is one of the two
// constants above; the user's text is always $1.
const leafSql = {
  term: (cfg: Config) => `plainto_tsquery('${cfg}', $1)`,
  phrase: (cfg: Config) => `phraseto_tsquery('${cfg}', $1)`,
  prefix: (cfg: Config) =>
    `(plainto_tsquery('${cfg}', $1)::text || ':*')::tsquery`,
};
const guard = { english: "a.language = 'en'", simple: "a.language <> 'en'" };

async function ids(
  cfg: Config,
  kind: keyof typeof leafSql,
  text: string,
): Promise<number[]> {
  const { rows } = await db.query<{ external_id: number }>(
    `SELECT a.external_id FROM articles a
     WHERE ${guard[cfg]} AND a.tsv @@ ${leafSql[kind](cfg)} ORDER BY 1`,
    [text],
  );
  return rows.map((r) => r.external_id);
}

async function numnode(
  cfg: Config,
  kind: "term" | "phrase",
  text: string,
): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT numnode(${leafSql[kind](cfg)}) AS n`,
    [text],
  );
  return rows[0]!.n;
}

// The spec's Postgres behaviours that were written from knowledge, not run (plan §5),
// and the four assumptions of the phase 2 notes. The compiler is built on these.
describe("postgres assumptions (spike)", () => {
  describe("a. prefix cast", () => {
    it("matches a plain prefix under english", async () => {
      expect(await ids("english", "prefix", "renew")).toContain(5);
    });

    it.each(CONFIGS)(
      "runs for a prefix made of quote and operator characters (%s)",
      async (cfg) => {
        const { rows } = await db.query<{ q: string }>(
          `SELECT ${leafSql.prefix(cfg)}::text AS q`,
          ["a'b:c&d"],
        );
        console.log(`[spike a] ${cfg}: a'b:c&d* compiles to ${rows[0]!.q}`);
        expect(await ids(cfg, "prefix", "a'b:c&d")).toEqual([]);
      },
    );
  });

  describe("b. stop-word prefix, the*", () => {
    it("the raw cast is a syntax error under english", async () => {
      await expect(ids("english", "prefix", "the")).rejects.toThrow(
        /syntax error in tsquery/,
      );
    });

    it("numnode reports the leaf as empty under english, not under simple", async () => {
      expect(await numnode("english", "term", "the")).toBe(0);
      expect(await numnode("simple", "term", "the")).toBeGreaterThan(0);
    });
  });

  describe("c. the tsv GIN index can serve each per-config leaf", () => {
    // 20 rows always seq-scan. With seq scans disabled, a predicate the index cannot
    // serve still seq-scans, so this tells "usable" from "not usable". It does not
    // show the planner picks the index at scale (phase 5).
    async function plan(sql: string, text: string): Promise<string> {
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL enable_seqscan = off");
        const { rows } = await client.query<{ "QUERY PLAN": string }>(
          "EXPLAIN " + sql,
          [text],
        );
        return rows.map((r) => r["QUERY PLAN"]).join("\n");
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    }

    const cases = CONFIGS.flatMap((cfg) =>
      (["term", "phrase", "prefix"] as const).map((kind) => ({ cfg, kind })),
    );
    it.each(cases)("$kind under $cfg", async ({ cfg, kind }) => {
      const text = await plan(
        `SELECT a.id FROM articles a WHERE a.tsv @@ ${leafSql[kind](cfg)}`,
        "oil",
      );
      expect(text).toMatch(/Bitmap Index Scan on articles_tsv_idx/);
    });

    it("the two fragments under their language guards, ORed", async () => {
      const text = await plan(
        `SELECT a.id FROM articles a
         WHERE (a.language = 'en' AND a.tsv @@ plainto_tsquery('english', $1))
            OR (a.language <> 'en' AND a.tsv @@ plainto_tsquery('simple', $1))`,
        // stems differently per config, so the two tsqueries cannot be merged
        "prices",
      );
      console.log("[spike c] guarded OR plan:\n" + text);
      expect(text).toMatch(/Bitmap Index Scan on articles_tsv_idx/);
    });
  });

  // d and e back the two `provisional` expectations. Logged, not asserted: turning
  // them into `fixed` is a human decision (search-check skill).
  describe("d, e. Chinese under simple", () => {
    it("logs what 中国 and 中国* match", async () => {
      console.log(
        "[spike d] 中国 (term, simple):",
        await ids("simple", "term", "中国"),
      );
      console.log(
        "[spike e] 中国* (prefix, simple):",
        await ids("simple", "prefix", "中国"),
      );
      const { rows } = await db.query<{ q: string }>(
        "SELECT plainto_tsquery('simple', $1)::text AS q",
        ["中国"],
      );
      console.log("[spike d] 中国 as a simple tsquery:", rows[0]!.q);
    });
  });

  // A sample, not a proof of "always": one string per script and shape the lexer lets
  // through (deviation 3).
  describe("f. a leaf with a letter or digit yields a lexeme under simple", () => {
    it.each([
      "a",
      "AI",
      "7",
      "2024",
      "the",
      "and",
      "é",
      "naïve",
      "دبي",
      "中",
      "中国",
      "a'b:c&d",
      "state-of-the-art",
      "x!",
      "!x",
      "a_b",
      "№5",
    ])("%s", async (text) => {
      expect(await numnode("simple", "term", text)).toBeGreaterThan(0);
      expect(await numnode("simple", "phrase", text)).toBeGreaterThan(0);
    });
  });

  describe("g. a punctuation-only string yields no lexeme under either config", () => {
    const strings = ["!!!", "---", "&|", "'", ":", ":*", "<->", "?!.,;", "…"];
    const cases = CONFIGS.flatMap((cfg) =>
      strings.map((text) => ({ cfg, text })),
    );
    it.each(cases)("$text under $cfg", async ({ cfg, text }) => {
      expect(await numnode(cfg, "term", text)).toBe(0);
      expect(await numnode(cfg, "phrase", text)).toBe(0);
    });
  });
});
