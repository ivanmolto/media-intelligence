// Boolean search against the seeded media_test database (plan §3, phase 2).
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { InvalidCursorError } from "@/lib/articles/cursor";
import { Params, type RunKey } from "@/lib/articles/filters";
import { listArticles } from "@/lib/articles/list";
import { leavesOf } from "@/lib/search/ast";
import {
  compileConfig,
  compileWhere,
  prepareSearch,
  searchIds,
  warningsFor,
} from "@/lib/search/compile";
import type { EmptyLeaves } from "@/lib/search/leaves";
import { InvalidQueryError, parseQuery } from "@/lib/search/parser";
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

// ---------------------------------------------------------------------------
// The empty-leaf rule, on hand-made pre-query results: no database needed.
// ---------------------------------------------------------------------------
describe("empty-leaf rule (spec §2)", () => {
  /** Compiles `query` for english with the named leaves treated as empty. */
  function english(query: string, ...emptyLeaves: string[]) {
    const ast = parseQuery(query);
    const positions = leavesOf(ast).flatMap((leaf, i) =>
      emptyLeaves.includes(leaf.text) ? [i] : [],
    );
    const empty: EmptyLeaves = {
      english: new Set(positions),
      simple: new Set(),
    };
    const params = new Params();
    const sql = compileConfig(ast, empty, "english", params.add);
    return { sql, params: params.values, warnings: warningsFor(ast, empty) };
  }
  const T = (n: number) => `a.tsv @@ plainto_tsquery('english', $${n})`;

  it("compiles each leaf kind to one parameter", () => {
    expect(english('oil "supply chain" renew*')).toEqual({
      sql:
        `((${T(1)} AND a.tsv @@ phraseto_tsquery('english', $2))` +
        ` AND a.tsv @@ (plainto_tsquery('english', $3)::text || ':*')::tsquery)`,
      params: ["oil", "supply chain", "renew"],
      warnings: [],
    });
  });

  it("keeps the AST's grouping and operators", () => {
    expect(english("a OR b AND NOT (c OR d)").sql).toBe(
      `(${T(1)} OR (${T(2)} AND NOT (${T(3)} OR ${T(4)})))`,
    );
  });

  it.each([
    // an operator left with one operand collapses to that operand
    ["oil and gas", ["and"], `(${T(1)} AND ${T(2)})`, ["oil", "gas"]],
    ["the OR oil", ["the"], T(1), ["oil"]],
    ["oil OR the", ["the"], T(1), ["oil"]],
    ["(the OR and) AND oil", ["the", "and"], T(1), ["oil"]],
    // x AND NOT <removed> becomes x
    ["oil AND NOT the", ["the"], T(1), ["oil"]],
    ["oil AND NOT (the OR and)", ["the", "and"], T(1), ["oil"]],
    // <removed> AND NOT x: the removed side contributes nothing, the negation stays
    ["the AND NOT oil", ["the"], `NOT (${T(1)})`, ["oil"]],
    [
      "gas AND (the AND NOT oil)",
      ["the"],
      `(${T(1)} AND NOT (${T(2)}))`,
      ["gas", "oil"],
    ],
    // a prefix is removed like a term, so the cast is never built for it
    ["the* OR oil", ["the"], T(1), ["oil"]],
  ])("%s", (query, empty, sql, params) => {
    const result = english(query, ...empty);
    expect(result.sql).toBe(sql);
    expect(result.params).toEqual(params);
  });

  it("a fragment with no leaf left matches nothing", () => {
    expect(english("the and", "the", "and")).toEqual({
      sql: "FALSE",
      params: [],
      warnings: ["the", "and"],
    });
  });

  it("warns with the leaf as typed, once each, in query order", () => {
    expect(
      english('the* OR "of the" OR oil OR the* OR and', "the", "of the", "and")
        .warnings,
    ).toEqual(["the*", '"of the"', "and"]);
  });

  it("joins the two configs under the language guard, numbering parameters in order", () => {
    const ast = parseQuery("oil and gas");
    const empty: EmptyLeaves = { english: new Set([1]), simple: new Set() };
    const params = new Params();
    params.add("an earlier filter");
    expect(compileWhere(ast, empty, params.add)).toBe(
      "(a.language = 'en' AND ((a.tsv @@ plainto_tsquery('english', $2) AND a.tsv @@ plainto_tsquery('english', $3))))" +
        " OR (a.language <> 'en' AND (((a.tsv @@ plainto_tsquery('simple', $4) AND a.tsv @@ plainto_tsquery('simple', $5)) AND a.tsv @@ plainto_tsquery('simple', $6))))",
    );
    expect(params.values).toEqual([
      "an earlier filter",
      "oil",
      "gas",
      "oil",
      "and",
      "gas",
    ]);
  });
});

// ---------------------------------------------------------------------------
// The shared expectations (deviation 5). Nothing expected is written in this file.
// ---------------------------------------------------------------------------
type Case = {
  id: string;
  status: "fixed" | "provisional";
  query: string;
  expect: {
    ids?: number[];
    warnings?: string[];
    error?: string;
    notError?: string;
  };
  sqlMustNotContain?: string[];
};
const expectations = JSON.parse(
  readFileSync(
    new URL("./fixtures/search-expectations.json", import.meta.url),
    "utf8",
  ),
) as { cases: Case[] };

type Outcome = { ids: number[]; warnings: string[] } | { error: string };

/** What the API will answer: a result, `invalid_query`, or `internal` for anything else. */
async function run(query: string): Promise<Outcome> {
  try {
    return await searchIds(db, query);
  } catch (error) {
    return {
      error: error instanceof InvalidQueryError ? error.code : "internal",
    };
  }
}

describe("search expectations file", () => {
  it("has cases, each with a unique id", () => {
    const ids = expectations.cases.map((c) => c.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  describe.each(expectations.cases.filter((c) => c.status === "fixed"))(
    "$id: $query",
    (c) => {
      it("returns what the file expects", async () => {
        const outcome = await run(c.query);
        if (c.expect.error !== undefined) {
          expect(outcome).toEqual({ error: c.expect.error });
        } else if (c.expect.notError !== undefined) {
          expect(outcome).not.toEqual({ error: c.expect.notError });
        } else {
          expect(outcome).toEqual({
            ids: c.expect.ids,
            warnings: c.expect.warnings,
          });
        }
      });

      if (c.sqlMustNotContain) {
        it("keeps the user's text out of the SQL of both fragments", async () => {
          const { debug, fragment } = await prepareSearch(db, c.query);
          const params = new Params();
          const texts = [
            debug.fragments.english.sql,
            debug.fragments.simple.sql,
            fragment.build(params.add),
          ];
          for (const text of texts) {
            for (const banned of c.sqlMustNotContain!) {
              expect(text).not.toContain(banned);
            }
          }
          // the text went to the parameters instead
          expect(debug.fragments.simple.params.join(" ")).toContain(
            c.sqlMustNotContain![0],
          );
        });
      }
    },
  );

  // Run and reported, never asserted, until the file says `fixed`.
  it.each(expectations.cases.filter((c) => c.status === "provisional"))(
    "provisional $id: $query (logged, not asserted)",
    async (c) => {
      console.log(
        `[provisional] ${c.id}: expected ${JSON.stringify(c.expect)}, actual ${JSON.stringify(await run(c.query))}`,
      );
    },
  );
});

describe("no query is a 500 (S3)", () => {
  it.each([
    "a'b:c&d*",
    "the*",
    '"the"',
    "the",
    "x'",
    "a\\b",
    "a:*",
    "a&b|c!d",
    "<->x",
    "x:A",
    "$1",
    "'; SELECT pg_sleep(1); --x",
    '"\'; SELECT pg_sleep(1); --x"',
    "%_x",
    "a\u0000b",
    '"oil \u0000 prices"',
  ])("%j", async (query) => {
    expect(await run(query)).not.toEqual({ error: "internal" });
  });
});

describe("search in the shared filter slot", () => {
  const runKey: RunKey = {
    requestedModel: "search-test",
    promptVersion: "v1",
    taxonomyVersion: "v1",
  };

  it("pages through a search with another filter, and matches searchIds", async () => {
    const query = "the OR oil OR ai";
    const { fragment } = await prepareSearch(db, query);
    const filters = { language: "en", search: fragment };
    const seen: number[] = [];
    let cursor: string | undefined;
    do {
      const page = await listArticles(db, {
        filters,
        runKey,
        cursor,
        limit: 2,
      });
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined && seen.length < 50);

    const { ids } = await searchIds(db, query);
    expect(seen.length).toBeGreaterThan(2);
    expect([...seen].sort((a, b) => a - b)).toEqual(ids);
  });

  it("a cursor issued for one query is refused for another", async () => {
    const first = await prepareSearch(db, "oil OR ai OR energy");
    const page = await listArticles(db, {
      filters: { search: first.fragment },
      runKey,
      limit: 1,
    });
    expect(page.nextCursor).not.toBeNull();
    const other = await prepareSearch(db, "oil OR ai");
    await expect(
      listArticles(db, {
        filters: { search: other.fragment },
        runKey,
        cursor: page.nextCursor!,
        limit: 1,
      }),
    ).rejects.toBeInstanceOf(InvalidCursorError);
  });
});
