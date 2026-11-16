// The shared FROM/WHERE builder. The list and the aggregate both take their rows
// from here, so a search result and its chart can never disagree (spec §1).
//
// Every value becomes a `$n` parameter. The SQL text is made of the constants in
// this file and the placeholders `Params.add` returns; no value is ever part of it.
import { filterHash } from "./cursor";

/** One enrichment run (spec §1, "Run key"). Resolved from the environment by the caller. */
export type RunKey = {
  requestedModel: string;
  promptVersion: string;
  taxonomyVersion: string;
};

/**
 * The slot for boolean search (phase 2). `build` returns a WHERE fragment over the
 * alias `a`, registering each leaf through `param`; `key` is the query as typed,
 * used only for the cursor's filter hash.
 */
export type SearchFragment = {
  key: string;
  build: (param: (value: unknown) => string) => string;
};

export type ArticleFilters = {
  source?: string;
  language?: string;
  /** inclusive */
  from?: Date;
  /** exclusive */
  to?: Date;
  /** on the run key's enrichment row */
  sentiment?: string;
  /** a taxonomy id; on the run key's enrichment row */
  topic?: string;
  search?: SearchFragment;
};

/** Collects parameter values and hands out their placeholders. */
export class Params {
  readonly values: unknown[] = [];
  add = (value: unknown): string => {
    this.values.push(value);
    return "$" + this.values.length;
  };
}

/**
 * `articles a` joined to its enrichment row for one run key: at most one row per
 * article, because the run key plus article_id is that table's primary key.
 */
export function buildFrom(runKey: RunKey, params: Params): string {
  return [
    "FROM articles a",
    "LEFT JOIN article_enrichments e",
    "  ON e.article_id = a.id",
    "  AND e.requested_model = " + params.add(runKey.requestedModel),
    "  AND e.prompt_version = " + params.add(runKey.promptVersion),
    "  AND e.taxonomy_version = " + params.add(runKey.taxonomyVersion),
  ].join("\n");
}

/** The filter conditions, ANDed; "TRUE" when there are none. */
export function buildWhere(filters: ArticleFilters, params: Params): string {
  const conditions: string[] = [];
  if (filters.source !== undefined) {
    conditions.push("a.source = " + params.add(filters.source));
  }
  if (filters.language !== undefined) {
    conditions.push("a.language = " + params.add(filters.language));
  }
  if (filters.from !== undefined) {
    conditions.push("a.published_at >= " + params.add(filters.from));
  }
  if (filters.to !== undefined) {
    conditions.push("a.published_at < " + params.add(filters.to));
  }
  if (filters.sentiment !== undefined) {
    conditions.push("e.sentiment = " + params.add(filters.sentiment));
  }
  if (filters.topic !== undefined) {
    // `@>` so the GIN index on tags can serve it
    conditions.push(
      "e.tags @> ARRAY[" + params.add(filters.topic) + "]::text[]",
    );
  }
  if (filters.search !== undefined) {
    conditions.push("(" + filters.search.build(params.add) + ")");
  }
  return conditions.length === 0 ? "TRUE" : conditions.join(" AND ");
}

/** Identifies a filter set and run key, so a cursor cannot be replayed on another. */
export function filtersHash(filters: ArticleFilters, runKey: RunKey): string {
  return filterHash({
    source: filters.source,
    language: filters.language,
    from: filters.from?.toISOString(),
    to: filters.to?.toISOString(),
    sentiment: filters.sentiment,
    topic: filters.topic,
    q: filters.search?.key,
    run: [runKey.requestedModel, runKey.promptVersion, runKey.taxonomyVersion],
  });
}
