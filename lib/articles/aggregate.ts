// Counts per time bucket for a filter set (spec §1, Aggregate). Takes the same
// FROM/WHERE as the list. Empty buckets are not zero-filled.
import type { Queryable } from "../db";
import {
  type ArticleFilters,
  buildFrom,
  buildWhere,
  Params,
  type RunKey,
} from "./filters";

// Whitelists: the request names a key, the SQL gets the constant. Buckets are UTC;
// a week is ISO (starts Monday).
const BUCKETS = {
  week: "date_trunc('week', a.published_at AT TIME ZONE 'UTC')",
  month: "date_trunc('month', a.published_at AT TIME ZONE 'UTC')",
} as const;

const GROUPS = {
  sentiment: { column: "e.sentiment", join: "" },
  source: { column: "a.source", join: "" },
  // One row per tag: an article with several tags is counted once per tag, so the
  // groups do not sum to the article total. LEFT JOIN keeps un-enriched articles,
  // as group NULL.
  topic: {
    column: "t.tag",
    join: "LEFT JOIN LATERAL unnest(e.tags) AS t(tag) ON TRUE",
  },
} as const;

export type Bucket = keyof typeof BUCKETS;
export type GroupBy = keyof typeof GROUPS;
export const DEFAULT_BUCKET: Bucket = "week";

export const isBucket = (value: string): value is Bucket =>
  Object.hasOwn(BUCKETS, value);
export const isGroupBy = (value: string): value is GroupBy =>
  Object.hasOwn(GROUPS, value);

export type AggregateRequest = {
  filters: ArticleFilters;
  runKey: RunKey;
  bucket?: Bucket;
  groupBy?: GroupBy;
};

export type AggregateRow = {
  /** first day of the bucket, YYYY-MM-DD, UTC */
  bucket: string;
  /** only with groupBy; null = no enrichment value for that article */
  group?: string | null;
  count: number;
};

export async function aggregateArticles(
  db: Queryable,
  request: AggregateRequest,
): Promise<AggregateRow[]> {
  const bucket = request.bucket ?? DEFAULT_BUCKET;
  // A key that is not in the whitelist never reaches the SQL text.
  if (!isBucket(bucket)) throw new RangeError("unknown bucket");
  if (request.groupBy !== undefined && !isGroupBy(request.groupBy)) {
    throw new RangeError("unknown group_by");
  }
  const group = request.groupBy ? GROUPS[request.groupBy] : null;

  const params = new Params();
  const from = buildFrom(request.runKey, params);
  const where = buildWhere(request.filters, params);
  const bucketColumn =
    "to_char(" + BUCKETS[bucket] + ", 'YYYY-MM-DD') AS bucket";

  const sql = [
    "SELECT " + bucketColumn + ",", // audit: sql-fragment — bucket expression is a constant from the BUCKETS whitelist
    (group ? group.column : "NULL::text") + ' AS "group",',
    "  count(*)::int AS count",
    from,
    group ? group.join : "",
    "WHERE " + where, // audit: sql-fragment — conditions are constants and $n placeholders from filters.ts
    "GROUP BY 1, 2",
    "ORDER BY 1, 2",
  ].join("\n");

  const { rows } = await db.query<{
    bucket: string;
    group: string | null;
    count: number;
  }>(sql, params.values);

  return rows.map((row) =>
    group
      ? { bucket: row.bucket, group: row.group, count: row.count }
      : { bucket: row.bucket, count: row.count },
  );
}
