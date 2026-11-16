// The global setup has already migrated and seeded media_test once.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { migrate } from "../scripts/migrate";
import { loadSampleArticles, seed, toRow } from "../scripts/seed";
import { testDatabaseUrl } from "./db-url";

const db = new Client({ connectionString: testDatabaseUrl() });
beforeAll(() => db.connect());
afterAll(() => db.end());

const TSV_SOURCE = "headline_text || ' ' || body_text";

describe("migrate", () => {
  it("is idempotent: a second run applies nothing", async () => {
    expect(await migrate(db)).toEqual([]);
  });

  it("created the six indexes of spec §1", async () => {
    const { rows } = await db.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname NOT LIKE '%pkey' AND indexname NOT LIKE '%key' ORDER BY 1",
    );
    expect(rows.map((r) => r.indexname)).toEqual([
      "article_enrichments_dedup_idx",
      "article_enrichments_tags_idx",
      "articles_language_published_idx",
      "articles_published_idx",
      "articles_source_published_idx",
      "articles_tsv_idx",
    ]);
  });
});

describe("seed", () => {
  it("is idempotent: a second run inserts 0 rows (S1)", async () => {
    expect(await seed(db, loadSampleArticles())).toBe(0);
    const { rows } = await db.query("SELECT count(*)::int AS n FROM articles");
    expect(rows[0].n).toBe(20);
  });

  it("stores article 17 with an empty headline, not null", async () => {
    const { rows } = await db.query(
      "SELECT headline, headline_text FROM articles WHERE external_id = 17",
    );
    expect(rows[0].headline).toBe("");
    expect(rows[0].headline_text).toBe("");
  });

  it("stores the raw body, the stripped body_text and the content hash", async () => {
    const expected = toRow(loadSampleArticles().find((a) => a.id === 6)!);
    const { rows } = await db.query(
      "SELECT headline, headline_text, body, body_text, content_hash, published_at FROM articles WHERE external_id = 6",
    );
    expect(rows[0].headline).toBe(expected.headline);
    expect(rows[0].headline_text).toBe("Breaking: Major Data Breach Reported");
    expect(rows[0].body).toBe(expected.body);
    expect(rows[0].body_text).toBe(expected.bodyText);
    expect(rows[0].content_hash.equals(expected.contentHash)).toBe(true);
    expect(rows[0].published_at.toISOString()).toBe("2026-07-07T19:30:00.000Z");
  });
});

describe("generated tsv column (plan §5, first unverified assumption)", () => {
  it("is populated for all 20 articles", async () => {
    const { rows } = await db.query(
      "SELECT count(*)::int AS n FROM articles WHERE tsv IS NULL OR tsv = ''::tsvector",
    );
    expect(rows[0].n).toBe(0);
  });

  it("uses the english config for 'en' and simple for everything else", async () => {
    const { rows } = await db.query<{
      language: string;
      is_english: boolean;
      is_simple: boolean;
    }>(
      // TSV_SOURCE is a constant in this file
      `SELECT language, tsv = to_tsvector('english', ${TSV_SOURCE}) AS is_english,
              tsv = to_tsvector('simple', ${TSV_SOURCE}) AS is_simple
       FROM articles`,
    );
    expect(rows).toHaveLength(20);
    for (const row of rows) {
      if (row.language === "en") {
        expect(row.is_english, row.language).toBe(true);
        expect(row.is_simple, row.language).toBe(false);
      } else {
        // Only `simple` is asserted here: for Arabic text the english config
        // gives the same vector, having nothing to stem and no stop word to drop.
        expect(row.is_simple, row.language).toBe(true);
      }
    }
  });

  it("stems English: article 1 ('Prices') matches the lexeme 'price'", async () => {
    const { rows } = await db.query(
      "SELECT external_id FROM articles WHERE tsv @@ to_tsquery('english', 'price') AND external_id = 1",
    );
    expect(rows).toHaveLength(1);
  });

  // Postgres indexes the words inside a tag: built from the raw headline, this
  // vector held img, src, onerror, alert and xss. It is built from headline_text
  // (deviation 15).
  it("article 6: the words of the headline's HTML tag are not indexed", async () => {
    const { rows } = await db.query<{ lexemes: string[] }>(
      "SELECT tsvector_to_array(tsv) AS lexemes FROM articles WHERE external_id = 6",
    );
    const lexemes = rows[0]?.lexemes ?? [];
    expect(lexemes).toContain("breach");
    for (const word of ["img", "src", "onerror", "alert", "xss"]) {
      expect(lexemes, word).not.toContain(word);
    }
  });
});
