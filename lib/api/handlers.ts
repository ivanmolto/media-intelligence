// The two article endpoints (spec §4). The route files only pass the URL in: the
// `no-sql-in-routes` audit rule keeps the database out of them, so the pool is
// resolved here, and a test can pass its own `Queryable` (deviation 23).
//
// Web `Response` only; nothing from Next is imported under lib/.
import { aggregateArticles } from "../articles/aggregate";
import type { ArticleFilters } from "../articles/filters";
import { listArticles } from "../articles/list";
import { getPool, type Queryable } from "../db";
import { activeRunKey } from "../enrich/provider";
import { prepareSearch } from "../search/compile";
import { errorResponse } from "./errors";
import {
  type FilterParams,
  parseAggregateParams,
  parseListParams,
} from "./params";

/** Said in the response when groups are topics (spec §1, Aggregate; deviation 22). */
export const TOPIC_NOTE =
  "group_by=topic counts an article once per tag, so the groups do not sum to the number of articles";

/** Adds the compiled search to the filters; one database round trip when `q` is set. */
async function withSearch(
  db: Queryable,
  { q, filters }: FilterParams,
): Promise<{ filters: ArticleFilters; warnings: string[] }> {
  if (q === undefined) return { filters, warnings: [] };
  const { fragment, warnings } = await prepareSearch(db, q);
  return { filters: { ...filters, search: fragment }, warnings };
}

/** GET /api/articles → {items, next_cursor, warnings} */
export async function articlesResponse(
  url: URL,
  db?: Queryable,
): Promise<Response> {
  try {
    const params = parseListParams(url.searchParams);
    const database = db ?? getPool();
    const { filters, warnings } = await withSearch(database, params);
    const { items, nextCursor } = await listArticles(database, {
      filters,
      runKey: activeRunKey(),
      cursor: params.cursor,
      limit: params.limit,
    });
    return Response.json({ items, next_cursor: nextCursor, warnings });
  } catch (error) {
    return errorResponse(error);
  }
}

/** GET /api/articles/aggregate → {buckets, warnings, notes} */
export async function aggregateResponse(
  url: URL,
  db?: Queryable,
): Promise<Response> {
  try {
    const params = parseAggregateParams(url.searchParams);
    const database = db ?? getPool();
    const { filters, warnings } = await withSearch(database, params);
    const buckets = await aggregateArticles(database, {
      filters,
      runKey: activeRunKey(),
      bucket: params.bucket,
      groupBy: params.groupBy,
    });
    return Response.json({
      buckets,
      warnings,
      notes: params.groupBy === "topic" ? [TOPIC_NOTE] : [],
    });
  } catch (error) {
    return errorResponse(error);
  }
}
