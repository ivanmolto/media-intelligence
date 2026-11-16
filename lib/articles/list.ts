// Keyset-paginated article list (spec §1, Pagination). No OFFSET: a page costs the
// same wherever it is.
import type { Queryable } from "../db";
import { decodeCursor, encodeCursor } from "./cursor";
import {
  type ArticleFilters,
  buildFrom,
  buildWhere,
  filtersHash,
  Params,
  type RunKey,
} from "./filters";

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export type ArticleItem = {
  /** the brief's id */
  id: number;
  headline: string;
  source: string;
  language: string;
  published_at: string;
  /** present when the active run key has a row for this article */
  enrichment?: {
    status: string;
    summary: string | null;
    sentiment: string | null;
    tags: string[] | null;
  };
};

export type ListRequest = {
  filters: ArticleFilters;
  runKey: RunKey;
  cursor?: string;
  limit?: number;
};

type Row = {
  row_id: string;
  external_id: number;
  headline: string | null;
  source: string;
  language: string;
  published_at: Date;
  cursor_ts: string;
  status: string | null;
  summary: string | null;
  sentiment: string | null;
  tags: string[] | null;
};

/** Throws InvalidCursorError for an unreadable cursor or one issued for other filters. */
export async function listArticles(
  db: Queryable,
  request: ListRequest,
): Promise<{ items: ArticleItem[]; nextCursor: string | null }> {
  const limit = Math.min(
    Math.max(Math.trunc(request.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1),
    MAX_LIMIT,
  );
  const hash = filtersHash(request.filters, request.runKey);
  const after =
    request.cursor === undefined ? null : decodeCursor(request.cursor, hash);

  const params = new Params();
  const from = buildFrom(request.runKey, params);
  const conditions = [buildWhere(request.filters, params)];
  if (after) {
    const position = [
      params.add(after.ts) + "::timestamptz",
      params.add(after.id) + "::bigint",
    ];
    conditions.push("(a.published_at, a.id) < (" + position.join(", ") + ")");
  }

  const sql = [
    "SELECT a.id AS row_id, a.external_id, a.headline, a.source, a.language, a.published_at,",
    `  to_char(a.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts,`,
    "  e.status, e.summary, e.sentiment, e.tags",
    from,
    "WHERE " + conditions.join(" AND "), // audit: sql-fragment — conditions are constants and $n placeholders from filters.ts
    "ORDER BY a.published_at DESC, a.id DESC",
    "LIMIT " + params.add(limit + 1), // audit: sql-fragment — the limit is a $n placeholder; one extra row tells whether a next page exists
  ].join("\n");

  const { rows } = await db.query<Row>(sql, params.values);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];

  return {
    items: page.map((row) => ({
      id: row.external_id,
      headline: row.headline ?? "",
      source: row.source,
      language: row.language,
      published_at: row.published_at.toISOString(),
      ...(row.status === null
        ? {}
        : {
            enrichment: {
              status: row.status,
              summary: row.summary,
              sentiment: row.sentiment,
              tags: row.tags,
            },
          }),
    })),
    nextCursor:
      rows.length > limit && last
        ? encodeCursor({ ts: last.cursor_ts, id: last.row_id }, hash)
        : null,
  };
}
