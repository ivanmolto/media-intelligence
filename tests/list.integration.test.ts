import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { InvalidCursorError } from "@/lib/articles/cursor";
import type { ArticleFilters, RunKey } from "@/lib/articles/filters";
import { type ArticleItem, listArticles } from "@/lib/articles/list";
import { testDatabaseUrl } from "./db-url";

const db = new Pool({ connectionString: testDatabaseUrl() });
const runKey: RunKey = {
  requestedModel: "list-test",
  promptVersion: "v1",
  taxonomyVersion: "v1",
};

// Enrichment rows for three articles, written here and removed afterwards.
beforeAll(async () => {
  await db.query("TRUNCATE article_enrichments");
  await db.query(
    `INSERT INTO article_enrichments
       (article_id, requested_model, prompt_version, taxonomy_version, status, summary, sentiment, tags)
     SELECT a.id, $1, $2, $3, 'done', 'summary of ' || a.external_id, v.sentiment, v.tags
     FROM (VALUES (1, 'negative', ARRAY['energy', 'geopolitics']),
                  (5, 'positive', ARRAY['energy', 'climate']),
                  (10, 'positive', ARRAY['ai', 'health'])) AS v (external_id, sentiment, tags)
     JOIN articles a ON a.external_id = v.external_id`,
    [runKey.requestedModel, runKey.promptVersion, runKey.taxonomyVersion],
  );
  // A row under another run key must never show up through `runKey`.
  await db.query(
    `INSERT INTO article_enrichments
       (article_id, requested_model, prompt_version, taxonomy_version, status, sentiment, tags)
     SELECT id, 'other-model', 'v1', 'v1', 'done', 'mixed', ARRAY['sports'] FROM articles`,
  );
});
afterAll(async () => {
  await db.query("TRUNCATE article_enrichments");
  await db.end();
});

async function pageThrough(
  filters: ArticleFilters,
  limit: number,
): Promise<ArticleItem[][]> {
  const pages: ArticleItem[][] = [];
  let cursor: string | undefined;
  do {
    const page = await listArticles(db, { filters, runKey, cursor, limit });
    pages.push(page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined && pages.length < 50);
  return pages;
}

// The sample's published_at values are all distinct, so newest-first is one order.
// external ids 1..20 happen to be in that order already (1 is the newest).
const NEWEST_FIRST = Array.from({ length: 20 }, (_, i) => i + 1);

describe("keyset pagination", () => {
  it.each([1, 7, 19, 20, 100])(
    "limit %i: every article exactly once, newest first",
    async (limit) => {
      const pages = await pageThrough({}, limit);
      expect(pages.flat().map((item) => item.id)).toEqual(NEWEST_FIRST);
      expect(pages).toHaveLength(Math.ceil(20 / limit));
      for (const page of pages) expect(page.length).toBeLessThanOrEqual(limit);
    },
  );

  it("orders by published_at, checked against the dates and not the ids", async () => {
    const items = (await pageThrough({}, 100)).flat();
    const dates = items.map((item) => item.published_at);
    expect(dates).toEqual([...dates].sort().reverse());
  });

  it("the last page has no next cursor", async () => {
    const page = await listArticles(db, { filters: {}, runKey, limit: 20 });
    expect(page.nextCursor).toBeNull();
  });

  it("clamps the limit to 1..100", async () => {
    const low = await listArticles(db, { filters: {}, runKey, limit: 0 });
    expect(low.items).toHaveLength(20); // 0 is not a limit: the default applies
    const negative = await listArticles(db, { filters: {}, runKey, limit: -5 });
    expect(negative.items).toHaveLength(1);
    const high = await listArticles(db, { filters: {}, runKey, limit: 5000 });
    expect(high.items).toHaveLength(20);
  });
});

describe("cursor and filters", () => {
  it("a cursor replayed with different filters is rejected (API: 400 invalid_cursor)", async () => {
    const first = await listArticles(db, { filters: {}, runKey, limit: 5 });
    expect(first.nextCursor).not.toBeNull();
    await expect(
      listArticles(db, {
        filters: { language: "en" },
        runKey,
        cursor: first.nextCursor!,
        limit: 5,
      }),
    ).rejects.toMatchObject({ code: "invalid_cursor" });
    await expect(
      listArticles(db, {
        filters: {},
        runKey: { ...runKey, requestedModel: "other-model" },
        cursor: first.nextCursor!,
      }),
    ).rejects.toBeInstanceOf(InvalidCursorError);
  });

  it("an unreadable cursor is rejected before any query", async () => {
    await expect(
      listArticles(db, { filters: {}, runKey, cursor: "not-a-cursor" }),
    ).rejects.toBeInstanceOf(InvalidCursorError);
  });

  it("pages through a filtered set: language = en", async () => {
    const pages = await pageThrough({ language: "en" }, 4);
    expect(pages.flat().map((item) => item.id)).toEqual(
      NEWEST_FIRST.filter((id) => id !== 8 && id !== 9),
    );
  });
});

describe("filters", () => {
  const ids = async (filters: ArticleFilters) =>
    (await pageThrough(filters, 100)).flat().map((item) => item.id);

  it("source", async () => {
    expect(await ids({ source: "Reuters" })).toEqual([1]);
    expect(await ids({ source: "新华社" })).toEqual([9]);
    expect(await ids({ source: "reuters" })).toEqual([]);
  });

  it("language", async () => {
    expect(await ids({ language: "ar" })).toEqual([8]);
    expect(await ids({ language: "zh" })).toEqual([9]);
  });

  it("date range: from is inclusive, to is exclusive", async () => {
    // article 5 is 2026-07-08T10:20:00Z, article 3 is 2026-07-10T06:00:00Z
    const from = new Date("2026-07-08T10:20:00Z");
    const to = new Date("2026-07-10T06:00:00Z");
    expect(await ids({ from, to })).toEqual([4, 5]);
    expect(await ids({ from: new Date("2026-07-14T08:30:00.001Z") })).toEqual(
      [],
    );
    expect(await ids({ to: new Date("2026-06-12T06:30:00Z") })).toEqual([]);
  });

  it("sentiment and topic read the run key's enrichment row only", async () => {
    expect(await ids({ sentiment: "positive" })).toEqual([5, 10]);
    expect(await ids({ topic: "energy" })).toEqual([1, 5]);
    expect(await ids({ topic: "energy", sentiment: "positive" })).toEqual([5]);
    // every article has 'mixed' / 'sports' under the other run key
    expect(await ids({ sentiment: "mixed" })).toEqual([]);
    expect(await ids({ topic: "sports" })).toEqual([]);
  });

  it("filters combine with AND", async () => {
    expect(await ids({ language: "en", source: "新华社" })).toEqual([]);
    expect(await ids({ language: "en", source: "CNBC" })).toEqual([10]);
  });

  it("a search fragment joins the same WHERE and shares the parameter list", async () => {
    const search = {
      key: "oil",
      build: (param: (value: unknown) => string) =>
        "a.tsv @@ plainto_tsquery('english', " + param("oil") + ")",
    };
    expect(await ids({ source: "Reuters", search })).toEqual([1]);
    expect(await ids({ source: "CNBC", search })).toEqual([]);
  });

  it("a value full of SQL is a value: it matches nothing and breaks nothing", async () => {
    expect(await ids({ source: "x' OR '1'='1" })).toEqual([]);
    expect(await ids({ topic: "'] ) OR TRUE --" })).toEqual([]);
    expect(await ids({})).toHaveLength(20);
  });
});

describe("items", () => {
  it("carry the brief's id, the raw headline and one enrichment row at most", async () => {
    const items = (await pageThrough({}, 100)).flat();
    expect(items).toHaveLength(20);

    const one = items.find((item) => item.id === 1)!;
    expect(one).toEqual({
      id: 1,
      headline: "Global Oil Prices Surge Amid Middle East Tensions",
      source: "Reuters",
      language: "en",
      published_at: "2026-07-14T08:30:00.000Z",
      enrichment: {
        status: "done",
        summary: "summary of 1",
        sentiment: "negative",
        tags: ["energy", "geopolitics"],
      },
    });

    // un-enriched under this run key: no enrichment, whatever other run keys hold
    expect(items.find((item) => item.id === 2)).not.toHaveProperty(
      "enrichment",
    );
    // article 17: the empty headline stays empty here; "(Untitled)" is the UI's job
    expect(items.find((item) => item.id === 17)!.headline).toBe("");
    // article 6: the headline is returned raw, for a text node to render
    expect(items.find((item) => item.id === 6)!.headline).toContain(
      "<img src=x",
    );
  });
});
