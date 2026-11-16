// AST → parameterised WHERE fragment (spec §2, "Compilation").
//
// The tree is compiled once per text-search config and the two results are joined
// under a language guard:
//
//   (a.language =  'en' AND <compiled with 'english'>)
//   OR
//   (a.language <> 'en' AND <compiled with 'simple'>)
//
// The config is a constant inside each fragment, so the GIN index on `tsv` can serve
// it. Every leaf is one `$n` parameter; Postgres turns it into a tsquery. No tsquery
// string and no SQL is ever assembled from the user's text: the SQL text below is
// made of the constants in this file and the placeholders the caller hands out.
import { Params, type SearchFragment } from "../articles/filters";
import type { Queryable } from "../db";
import { isLeaf, type Leaf, leafSource, leavesOf, type Node } from "./ast";
import { type EmptyLeaves, findEmptyLeaves } from "./leaves";
import { parseQuery } from "./parser";

export const CONFIGS = ["english", "simple"] as const;
export type Config = (typeof CONFIGS)[number];

/** A tree after the empty leaves of one config are removed. */
type Pruned =
  | Leaf
  | { type: "and" | "or" | "and_not"; left: Pruned; right: Pruned }
  /** what is left of `<removed> AND NOT x` */
  | { type: "not"; operand: Pruned };

/**
 * The empty-leaf rule for one config. A removed leaf contributes nothing (S6):
 * an operator left with one operand collapses to it, `x AND NOT <removed>` is `x`,
 * and `<removed> AND NOT x` is `NOT x`. Returns null when no leaf is left.
 */
function prune(root: Node, empty: Set<number>): Pruned | null {
  let position = 0;
  const walk = (node: Node): Pruned | null => {
    if (isLeaf(node)) return empty.has(position++) ? null : node;
    const left = walk(node.left);
    const right = walk(node.right);
    if (node.type === "and_not") {
      if (right === null) return left;
      if (left === null) return { type: "not", operand: right };
      return { type: "and_not", left, right };
    }
    if (left === null) return right;
    if (right === null) return left;
    return { type: node.type, left, right };
  };
  return walk(root);
}

/** The tsquery expression of one leaf. `placeholder` is a `$n`, never a value. */
function tsquery(leaf: Leaf, config: Config, placeholder: string): string {
  const phrase = leaf.type === "phrase";
  if (config === "english") {
    return phrase
      ? "phraseto_tsquery('english', " + placeholder + ")" // audit: sql-fragment — config is a constant; the leaf text is the $n placeholder
      : "plainto_tsquery('english', " + placeholder + ")"; // audit: sql-fragment — config is a constant; the leaf text is the $n placeholder
  }
  return phrase
    ? "phraseto_tsquery('simple', " + placeholder + ")" // audit: sql-fragment — config is a constant; the leaf text is the $n placeholder
    : "plainto_tsquery('simple', " + placeholder + ")"; // audit: sql-fragment — config is a constant; the leaf text is the $n placeholder
}

function emit(
  node: Pruned,
  config: Config,
  param: (value: unknown) => string,
): string {
  switch (node.type) {
    case "term":
    case "phrase":
      return "a.tsv @@ " + tsquery(node, config, param(node.text)); // audit: sql-fragment — operand is the constant expression built by tsquery()
    case "prefix":
      // Postgres normalises and quotes the lexeme, then `:*` is appended to its own
      // output. The pre-query has removed any prefix whose tsquery is empty, so the
      // cast never sees a bare ':*'.
      return (
        "a.tsv @@ (" + // audit: sql-fragment — constant text around the expression built by tsquery()
        tsquery(node, config, param(node.text)) +
        "::text || ':*')::tsquery" // audit: sql-fragment — constant text; `||` here is SQL, run by Postgres on its own output
      );
    case "not":
      return "NOT (" + emit(node.operand, config, param) + ")";
    case "and":
    case "or":
    case "and_not": {
      const operator = { and: " AND ", or: " OR ", and_not: " AND NOT " }[
        node.type
      ];
      return (
        "(" +
        emit(node.left, config, param) +
        operator +
        emit(node.right, config, param) +
        ")"
      );
    }
  }
}

/** One config's fragment; `FALSE` when the empty-leaf rule left nothing to match. */
export function compileConfig(
  ast: Node,
  empty: EmptyLeaves,
  config: Config,
  param: (value: unknown) => string,
): string {
  const pruned = prune(ast, empty[config]);
  return pruned === null ? "FALSE" : emit(pruned, config, param);
}

/** The whole search condition over the alias `a`. */
export function compileWhere(
  ast: Node,
  empty: EmptyLeaves,
  param: (value: unknown) => string,
): string {
  const english = compileConfig(ast, empty, "english", param);
  const simple = compileConfig(ast, empty, "simple", param);
  return (
    "(a.language = 'en' AND (" +
    english +
    ")) OR (a.language <> 'en' AND (" +
    simple +
    "))"
  );
}

/**
 * The leaves removed under `english`, as typed, once each, in query order (S6).
 * `simple` has no stop list, so it removes nothing a lexer-accepted leaf can be.
 */
export function warningsFor(ast: Node, empty: EmptyLeaves): string[] {
  const removed = leavesOf(ast)
    .filter((_, position) => empty.english.has(position))
    .map(leafSource);
  return [...new Set(removed)];
}

export type PreparedSearch = {
  /** plugs into `ArticleFilters.search`, shared by the list and the aggregate */
  fragment: SearchFragment;
  warnings: string[];
  /** what `npm run search:debug` prints and the tests check for user text in SQL */
  debug: {
    ast: Node;
    emptyLeaves: Record<Config, string[]>;
    fragments: Record<Config, { sql: string; params: unknown[] }>;
  };
};

/**
 * Parse, ask Postgres which leaves are empty, compile. Throws InvalidQueryError for
 * a query the grammar or the limits reject; makes one database round trip otherwise.
 */
export async function prepareSearch(
  db: Queryable,
  query: string,
): Promise<PreparedSearch> {
  const ast = parseQuery(query);
  const leaves = leavesOf(ast);
  const empty = await findEmptyLeaves(db, leaves);

  const sources = (config: Config) =>
    leaves.filter((_, i) => empty[config].has(i)).map(leafSource);
  const standalone = (config: Config) => {
    const params = new Params();
    return {
      sql: compileConfig(ast, empty, config, params.add),
      params: params.values,
    };
  };

  return {
    fragment: {
      key: query,
      build: (param) => compileWhere(ast, empty, param),
    },
    warnings: warningsFor(ast, empty),
    debug: {
      ast,
      emptyLeaves: { english: sources("english"), simple: sources("simple") },
      fragments: {
        english: standalone("english"),
        simple: standalone("simple"),
      },
    },
  };
}

/** The matching articles' `external_id`s in ascending order, with the warnings. */
export async function searchIds(
  db: Queryable,
  query: string,
): Promise<{ ids: number[]; warnings: string[] }> {
  const { fragment, warnings } = await prepareSearch(db, query);
  const params = new Params();
  const sql = [
    "SELECT a.external_id FROM articles a",
    "WHERE " + fragment.build(params.add), // audit: sql-fragment — the fragment is constants and $n placeholders from compileWhere
    "ORDER BY a.external_id",
  ].join("\n");
  const { rows } = await db.query<{ external_id: number }>(sql, params.values);
  return { ids: rows.map((row) => row.external_id), warnings };
}
