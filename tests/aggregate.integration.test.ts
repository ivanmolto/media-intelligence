import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  type AggregateRow,
  aggregateArticles,
  type Bucket,
} from "@/lib/articles/aggregate";
import type { ArticleFilters, RunKey } from "@/lib/articles/filters";
import { listArticles } from "@/lib/articles/list";
import { testDatabaseUrl } from "./db-url";

const db = new Pool({ connectionString: testDatabaseUrl() });
const runKey: RunKey = {
  requestedModel: "aggregate-test",
  promptVersion: "v1",
  taxonomyVersion: "v1",
};

// Four enriched articles; the other 16 have no row under this run key.
beforeAll(async () => {
  await db.query("TRUNCATE article_enrichments");
  await db.query(
    `INSERT INTO article_enrichments
       (article_id, requested_model, prompt_version, taxonomy_version, status, sentiment, tags)
     SELECT a.id, $1, $2, $3, v.status, v.sentiment, v.tags
     FROM (VALUES (1, 'done', 'negative', ARRAY['energy', 'geopolitics']),
                  (5, 'done', 'positive', ARRAY['energy', 'climate', 'economy']),
                  (10, 'done', 'positive', ARRAY['ai']),
                  (11, 'failed', NULL, NULL)) AS v (external_id, status, sentiment, tags)
     JOIN articles a ON a.external_id = v.external_id`,
    [runKey.requestedModel, runKey.promptVersion, runKey.taxonomyVersion],
  );
});
afterAll(async () => {
  await db.query("TRUNCATE article_enrichments");
  await db.end();
});

const total = (rows: AggregateRow[]) =>
  rows.reduce((sum, row) => sum + row.count, 0);

async function listCount(filters: ArticleFilters): Promise<number> {
  let count = 0;
  let cursor: string | undefined;
  do {
    const page = await listArticles(db, { filters, runKey, cursor, limit: 6 });
    count += page.items.length;
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return count;
}

const FILTER_SETS: [string, ArticleFilters, number][] = [
  ["no filter", {}, 20],
  ["source", { source: "Reuters" }, 1],
  ["language", { language: "en" }, 18],
  ["date range", { from: new Date("2026-07-01T00:00:00Z") }, 12],
  ["sentiment", { sentiment: "positive" }, 2],
  ["topic", { topic: "energy" }, 2],
  ["nothing matches", { source: "nobody" }, 0],
];

describe("aggregate totals equal the list for the same filters", () => {
  it.each(FILTER_SETS)("%s", async (_name, filters, expected) => {
    expect(await listCount(filters)).toBe(expected);
    for (const bucket of ["week", "month"] as Bucket[]) {
      const rows = await aggregateArticles(db, { filters, runKey, bucket });
      expect(total(rows), bucket).toBe(expected);
    }
  });
});

describe("buckets", () => {
  it("month: the sample spans June and July 2026", async () => {
    expect(
      await aggregateArticles(db, { filters: {}, runKey, bucket: "month" }),
    ).toEqual([
      { bucket: "2026-06-01", count: 8 },
      { bucket: "2026-07-01", count: 12 },
    ]);
  });

  it("week is the default; ISO weeks start on Monday, in UTC, oldest first", async () => {
    const rows = await aggregateArticles(db, { filters: {}, runKey });
    expect(rows).toEqual([
      { bucket: "2026-06-08", count: 1 }, // 20
      { bucket: "2026-06-15", count: 3 }, // 19, 18, 17
      { bucket: "2026-06-22", count: 3 }, // 16, 15, 14
      { bucket: "2026-06-29", count: 6 }, // 13, 12, 11, 10, 9, 8 (Sunday 5 July)
      { bucket: "2026-07-06", count: 6 }, // 7, 6, 5, 4, 3, 2 (Sunday 12 July)
      { bucket: "2026-07-13", count: 1 }, // 1
    ]);
    for (const row of rows) {
      expect(new Date(row.bucket + "T00:00:00Z").getUTCDay()).toBe(1);
      expect(row).not.toHaveProperty("group");
    }
  });

  it("empty buckets are not zero-filled", async () => {
    const rows = await aggregateArticles(db, {
      filters: { sentiment: "positive" },
      runKey,
    });
    expect(rows).toEqual([
      { bucket: "2026-06-29", count: 1 }, // 10
      { bucket: "2026-07-06", count: 1 }, // 5
    ]);
  });

  it("rejects a bucket or group that is not in the whitelist", async () => {
    const bucket = "day'); DROP TABLE articles; --" as Bucket;
    await expect(
      aggregateArticles(db, { filters: {}, runKey, bucket }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      aggregateArticles(db, {
        filters: {},
        runKey,
        groupBy: "constructor" as never,
      }),
    ).rejects.toBeInstanceOf(RangeError);
  });
});

describe("group_by", () => {
  it("sentiment: un-enriched and failed articles are the NULL group; totals still sum", async () => {
    const rows = await aggregateArticles(db, {
      filters: {},
      runKey,
      bucket: "month",
      groupBy: "sentiment",
    });
    expect(rows).toEqual([
      { bucket: "2026-06-01", group: null, count: 8 },
      { bucket: "2026-07-01", group: "negative", count: 1 },
      { bucket: "2026-07-01", group: "positive", count: 2 },
      { bucket: "2026-07-01", group: null, count: 9 },
    ]);
    expect(total(rows)).toBe(20);
  });

  it("source: one group per source, totals sum", async () => {
    const rows = await aggregateArticles(db, {
      filters: {},
      runKey,
      bucket: "month",
      groupBy: "source",
    });
    expect(rows).toHaveLength(20);
    expect(total(rows)).toBe(20);
    expect(rows).toContainEqual({
      bucket: "2026-07-01",
      group: "Reuters",
      count: 1,
    });
  });

  it("topic: an article counts once per tag, so the groups do not sum to the total", async () => {
    const rows = await aggregateArticles(db, {
      filters: {},
      runKey,
      bucket: "month",
      groupBy: "topic",
    });
    expect(rows).toEqual([
      { bucket: "2026-06-01", group: null, count: 8 },
      { bucket: "2026-07-01", group: "ai", count: 1 },
      { bucket: "2026-07-01", group: "climate", count: 1 },
      { bucket: "2026-07-01", group: "economy", count: 1 },
      { bucket: "2026-07-01", group: "energy", count: 2 },
      { bucket: "2026-07-01", group: "geopolitics", count: 1 },
      { bucket: "2026-07-01", group: null, count: 9 },
    ]);
    // 6 tag rows for 3 tagged articles + 17 untagged = 23, not 20
    expect(total(rows)).toBe(23);
  });
});
