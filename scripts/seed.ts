// npm run seed — loads docs/sample_articles.json into `articles`.
// Idempotent: a re-run inserts 0 rows (spec S1); an existing external_id is left as it is.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import type { Queryable } from "../lib/db";
import { stripHtml } from "../lib/html/strip";

const SAMPLE_FILE = fileURLToPath(
  new URL("../docs/sample_articles.json", import.meta.url),
);

export type SourceArticle = {
  id: number;
  headline: string;
  body: string;
  source: string;
  published_at: string;
  language: string;
};

export type ArticleRow = {
  externalId: number;
  headline: string;
  headlineText: string;
  body: string;
  bodyText: string;
  source: string;
  language: string;
  publishedAt: string;
  contentHash: Buffer;
};

const STRING_FIELDS = [
  "headline",
  "body",
  "source",
  "published_at",
  "language",
] as const;

/** A type guard for the source file, which is input like any other. */
export function parseArticles(data: unknown): SourceArticle[] {
  if (!Array.isArray(data)) throw new Error("articles: expected an array");
  return data.map((item: unknown, index) => {
    const record = (item ?? {}) as Record<string, unknown>;
    if (!Number.isInteger(record.id)) {
      throw new Error(`articles[${index}]: id must be an integer`);
    }
    for (const field of STRING_FIELDS) {
      if (typeof record[field] !== "string") {
        throw new Error(`articles[${index}]: ${field} must be a string`);
      }
    }
    if (Number.isNaN(Date.parse(record.published_at as string))) {
      throw new Error(`articles[${index}]: published_at is not a date`);
    }
    return record as SourceArticle;
  });
}

export function loadSampleArticles(): SourceArticle[] {
  return parseArticles(JSON.parse(readFileSync(SAMPLE_FILE, "utf8")));
}

const normalise = (text: string): string =>
  text.normalize("NFC").replace(/\s+/g, " ").trim();

/**
 * sha256 over the normalised stripped headline and body text. Normalised = NFC, whitespace
 * runs collapsed, trimmed; case is kept. The newline cannot occur inside either
 * part after normalisation, so it marks where the headline ends.
 */
export function contentHash(headlineText: string, bodyText: string): Buffer {
  return createHash("sha256")
    .update(normalise(headlineText) + "\n" + normalise(bodyText), "utf8")
    .digest();
}

export function toRow(article: SourceArticle): ArticleRow {
  const headlineText = stripHtml(article.headline);
  const bodyText = stripHtml(article.body);
  return {
    externalId: article.id,
    headline: article.headline, // raw, '' included (article 17)
    headlineText,
    body: article.body,
    bodyText,
    source: article.source,
    language: article.language,
    publishedAt: article.published_at,
    contentHash: contentHash(headlineText, bodyText),
  };
}

/** Inserts the articles that are not there yet, in one statement; returns how many. */
export async function seed(
  db: Queryable,
  articles: SourceArticle[],
): Promise<number> {
  const rows = articles.map(toRow);
  const result = await db.query(
    `INSERT INTO articles
       (external_id, headline, headline_text, body, body_text, source, language, published_at, content_hash)
     SELECT * FROM unnest(
       $1::int[], $2::text[], $3::text[], $4::text[], $5::text[],
       $6::text[], $7::text[], $8::timestamptz[], $9::bytea[])
     ON CONFLICT (external_id) DO NOTHING`,
    [
      rows.map((r) => r.externalId),
      rows.map((r) => r.headline),
      rows.map((r) => r.headlineText),
      rows.map((r) => r.body),
      rows.map((r) => r.bodyText),
      rows.map((r) => r.source),
      rows.map((r) => r.language),
      rows.map((r) => r.publishedAt),
      rows.map((r) => r.contentHash),
    ],
  );
  return result.rowCount ?? 0;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const articles = loadSampleArticles();
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const inserted = await seed(client, articles);
    console.log(`seed: inserted ${inserted} of ${articles.length} articles`);
  } finally {
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
