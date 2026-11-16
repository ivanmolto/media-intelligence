// The two article endpoints, through their route exports, against media_test
// (plan §3 phase 4 proof, as amended by phase-4-notes.md and deviations 2, 3, 5, 22).
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GET as aggregateRoute } from "@/app/api/articles/aggregate/route";
import { GET as articlesRoute } from "@/app/api/articles/route";
import {
  aggregateResponse,
  articlesResponse,
  TOPIC_NOTE,
} from "@/lib/api/handlers";
import { getPool, type Queryable } from "@/lib/db";
import { activeRunKey } from "@/lib/enrich/provider";
import { testDatabaseUrl } from "./db-url";

type Json = Record<string, unknown>;
type Item = {
  id: number;
  headline: string;
  enrichment?: { sentiment: string | null; tags: string[] | null };
};
type BucketRow = { bucket: string; group?: string | null; count: number };

// Search expectations come from the shared file only (deviation 5).
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
};
const { cases } = JSON.parse(
  readFileSync(
    new URL("./fixtures/search-expectations.json", import.meta.url),
    "utf8",
  ),
) as { cases: Case[] };
const fixed = cases.filter((c) => c.status === "fixed");

const BASE = "http://test";
const url = (path: string, params: Record<string, string> | string = {}) =>
  BASE + path + "?" + new URLSearchParams(params).toString();

async function call(
  route: (request: Request) => Promise<Response>,
  path: string,
  params: Record<string, string> | string = {},
): Promise<{ status: number; body: Json; text: string }> {
  const res = await route(new Request(url(path, params)));
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as Json, text };
}
const articles = (params: Record<string, string> | string = {}) =>
  call(articlesRoute, "/api/articles", params);
const aggregate = (params: Record<string, string> | string = {}) =>
  call(aggregateRoute, "/api/articles/aggregate", params);

const ids = (body: Json) =>
  (body.items as Item[]).map((item) => item.id).sort((a, b) => a - b);
const total = (body: Json) =>
  (body.buckets as BucketRow[]).reduce((sum, row) => sum + row.count, 0);

/** An error response is exactly {error: {code, message}}. */
function expectError(
  result: { status: number; body: Json },
  status: number,
  code: string,
): string {
  expect(result.status).toBe(status);
  expect(Object.keys(result.body)).toEqual(["error"]);
  const error = result.body.error as Json;
  expect(Object.keys(error).sort()).toEqual(["code", "message"]);
  expect(error.code).toBe(code);
  expect(typeof error.message).toBe("string");
  return error.message as string;
}

beforeAll(async () => {
  // The routes use the app's pool; here it is the test database, in mock mode.
  vi.stubEnv("DATABASE_URL", testDatabaseUrl());
  vi.stubEnv("LLM_MODE", "mock");
  const key = activeRunKey();
  const db = getPool();
  await db.query("TRUNCATE article_enrichments");
  await db.query(
    `INSERT INTO article_enrichments
       (article_id, requested_model, prompt_version, taxonomy_version, status, summary, sentiment, tags)
     SELECT a.id, $1, $2, $3, 'done', 'summary of ' || a.external_id, v.sentiment, v.tags
     FROM (VALUES (1, 'negative', ARRAY['energy', 'geopolitics']),
                  (5, 'positive', ARRAY['energy', 'climate']),
                  (10, 'positive', ARRAY['ai', 'health'])) AS v (external_id, sentiment, tags)
     JOIN articles a ON a.external_id = v.external_id`,
    [key.requestedModel, key.promptVersion, key.taxonomyVersion],
  );
});
afterAll(async () => {
  const db = getPool();
  await db.query("TRUNCATE article_enrichments");
  await db.end();
  vi.unstubAllEnvs();
});

describe("GET /api/articles — search, from search-expectations.json", () => {
  it.each(fixed)("$id: $query", async ({ query, expect: want }) => {
    const result = await articles({ q: query, limit: "100" });
    if (want.error !== undefined) {
      expectError(result, 400, want.error);
    } else if (want.notError !== undefined) {
      expect(result.status).not.toBe(500);
      if (result.status !== 200) {
        expect((result.body.error as Json).code).not.toBe(want.notError);
      }
    } else {
      expect(result.status).toBe(200);
      expect(ids(result.body)).toEqual(want.ids);
      expect(result.body.warnings).toEqual(want.warnings);
      expect(result.body.next_cursor).toBeNull();
    }
  });

  it("an invalid_query message is the parser's and names no SQL", async () => {
    const bad = fixed.find((c) => c.expect.error === "invalid_query")!;
    const message = expectError(
      await articles({ q: bad.query }),
      400,
      "invalid_query",
    );
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toMatch(/tsquery|SELECT|WHERE|\$\d/);
  });
});

describe("GET /api/articles — list", () => {
  it("returns the spec's shape, with the enrichment of the active run key", async () => {
    const { status, body } = await articles();
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual([
      "items",
      "next_cursor",
      "warnings",
    ]);
    expect(body.warnings).toEqual([]);
    const items = body.items as (Item & Json)[];
    expect(items).toHaveLength(20);
    const one = items.find((item) => item.id === 1)!;
    expect(Object.keys(one).sort()).toEqual([
      "enrichment",
      "headline",
      "id",
      "language",
      "published_at",
      "source",
    ]);
    expect(one.enrichment).toEqual({
      status: "done",
      summary: "summary of 1",
      sentiment: "negative",
      tags: ["energy", "geopolitics"],
    });
    // no row for the run key → no enrichment, and never a default sentiment
    expect(items.find((item) => item.id === 2)).not.toHaveProperty(
      "enrichment",
    );
  });

  it("pages through all 20 by cursor, each exactly once", async () => {
    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const params: Record<string, string> = { limit: "7" };
      if (cursor) params.cursor = cursor;
      const { status, body } = await articles(params);
      expect(status).toBe(200);
      seen.push(...(body.items as Item[]).map((item) => item.id));
      cursor = body.next_cursor as string | null;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(20);
    expect(new Set(seen).size).toBe(20);
  });

  it("filters by sentiment and by topic on the enrichment row", async () => {
    expect(ids((await articles({ sentiment: "positive" })).body)).toEqual([
      5, 10,
    ]);
    expect(ids((await articles({ topic: "energy" })).body)).toEqual([1, 5]);
    expect(
      ids((await articles({ topic: "energy", sentiment: "negative" })).body),
    ).toEqual([1]);
  });

  it("a date-only `to` includes that day; a time is an exclusive bound", async () => {
    const { body } = await articles({ limit: "100" });
    const newest = (body.items as (Item & { published_at: string })[])[0]!;
    const day = newest.published_at.slice(0, 10);
    expect(ids((await articles({ from: day, to: day })).body)).toContain(
      newest.id,
    );
    expect(
      ids((await articles({ to: newest.published_at })).body),
    ).not.toContain(newest.id);
  });

  it("an empty parameter is the same as none", async () => {
    const { status, body } = await articles("q=&sentiment=&limit=");
    expect(status).toBe(200);
    expect(body.items).toHaveLength(20);
  });
});

describe("400 invalid_cursor", () => {
  it("a cursor that is not readable", async () => {
    expectError(
      await articles({ cursor: "not-a-cursor" }),
      400,
      "invalid_cursor",
    );
  });

  it("a cursor issued for other filters", async () => {
    const first = await articles({ limit: "5" });
    const cursor = first.body.next_cursor as string;
    expect(cursor).toBeTruthy();
    expectError(
      await articles({ limit: "5", cursor, language: "en" }),
      400,
      "invalid_cursor",
    );
    const firstQuery = fixed.find((c) => c.expect.ids !== undefined)!;
    expectError(
      await articles({ limit: "5", cursor, q: firstQuery.query }),
      400,
      "invalid_cursor",
    );
  });
});

describe("400 invalid_param", () => {
  it.each([
    ["limit", "0"],
    ["limit", "101"],
    ["limit", "ten"],
    ["limit", "1.5"],
    ["sentiment", "happy"],
    ["sentiment", "positive' OR '1'='1"],
    ["topic", "gossip"],
    ["language", "EN"],
    ["language", "en; DROP TABLE articles"],
    ["source", "x".repeat(201)],
    ["from", "yesterday"],
    ["from", "2026-13-45"],
    ["to", "2026-07-01T10:00:00"],
  ])("articles: %s=%s", async (name, value) => {
    const message = expectError(
      await articles({ [name]: value }),
      400,
      "invalid_param",
    );
    expect(message).toContain(name);
  });

  it.each([
    ["bucket", "day"],
    ["bucket", "week; DROP TABLE articles"],
    ["group_by", "language"],
    ["group_by", "a.source"],
    ["sentiment", "happy"],
  ])("aggregate: %s=%s", async (name, value) => {
    const message = expectError(
      await aggregate({ [name]: value }),
      400,
      "invalid_param",
    );
    expect(message).toContain(name);
  });

  it("from after to", async () => {
    expectError(
      await articles({ from: "2026-07-10", to: "2026-07-01" }),
      400,
      "invalid_param",
    );
  });

  it("a parameter given twice", async () => {
    expectError(
      await articles("sentiment=positive&sentiment=negative"),
      400,
      "invalid_param",
    );
    expectError(
      await aggregate("bucket=week&bucket=month"),
      400,
      "invalid_param",
    );
  });
});

describe("GET /api/articles/aggregate", () => {
  it("defaults to week; week and month both sum to the list's total", async () => {
    const byDefault = await aggregate();
    const week = await aggregate({ bucket: "week" });
    const month = await aggregate({ bucket: "month" });
    expect(byDefault.status).toBe(200);
    expect(Object.keys(byDefault.body).sort()).toEqual([
      "buckets",
      "notes",
      "warnings",
    ]);
    expect(byDefault.body.buckets).toEqual(week.body.buckets);
    expect(total(week.body)).toBe(20);
    expect(total(month.body)).toBe(20);
    expect((month.body.buckets as BucketRow[]).length).toBeLessThan(
      (week.body.buckets as BucketRow[]).length,
    );
    expect(week.body.notes).toEqual([]);
    for (const row of week.body.buckets as BucketRow[]) {
      expect(Object.keys(row).sort()).toEqual(["bucket", "count"]);
      expect(row.bucket).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("takes the same filters as the list, so a search and its chart agree", async () => {
    for (const c of fixed.filter((c) => c.expect.ids !== undefined)) {
      const result = await aggregate({ q: c.query });
      expect(result.status).toBe(200);
      expect(total(result.body)).toBe(c.expect.ids!.length);
      expect(result.body.warnings).toEqual(c.expect.warnings);
    }
    const list = await articles({ sentiment: "positive", limit: "100" });
    const chart = await aggregate({ sentiment: "positive" });
    expect(total(chart.body)).toBe((list.body.items as Item[]).length);
  });

  it("a malformed query is the same 400 as on the list", async () => {
    const bad = fixed.find((c) => c.expect.error === "invalid_query")!;
    expectError(await aggregate({ q: bad.query }), 400, "invalid_query");
  });

  it("group_by=sentiment keeps un-enriched articles, as group null", async () => {
    const { body } = await aggregate({ group_by: "sentiment" });
    const rows = body.buckets as BucketRow[];
    expect(total(body)).toBe(20);
    const count = (group: string | null) =>
      rows.filter((r) => r.group === group).reduce((n, r) => n + r.count, 0);
    expect(count("positive")).toBe(2);
    expect(count("negative")).toBe(1);
    expect(count(null)).toBe(17);
    expect(body.notes).toEqual([]);
  });

  it("group_by=topic counts once per tag and says so in notes", async () => {
    const { body } = await aggregate({ group_by: "topic" });
    // 17 un-enriched (null) + 3 articles × 2 tags
    expect(total(body)).toBe(23);
    expect(body.notes).toEqual([TOPIC_NOTE]);
  });
});

describe("500 internal — a forced fault", () => {
  // A real request cannot produce a 500 on demand, so the query function is
  // replaced by one that throws what a driver would: SQL text and a connection string.
  const leak =
    'syntax error at or near "SELECT a.id FROM articles a WHERE tsv @@" — postgres://media:media@db:5432/media';
  const broken: Queryable = {
    query: () => Promise.reject(new Error(leak)),
  };

  it.each([
    ["articles", articlesResponse, "/api/articles"],
    ["aggregate", aggregateResponse, "/api/articles/aggregate"],
  ] as const)("%s", async (_name, respond, path) => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await respond(new URL(url(path, { q: "oil" })), broken);
      const text = await res.text();
      const message = expectError(
        { status: res.status, body: JSON.parse(text) as Json },
        500,
        "internal",
      );
      expect(message).toBe("internal error");
      expect(text).not.toMatch(/SELECT|articles|tsv|postgres|syntax/);
      // the detail goes to the server log, not to the client
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });
});
