// The empty-leaf pre-query (spec §2, "Empty-leaf rule"). Only Postgres knows each
// config's stop list, so one query asks it which leaves produce an empty tsquery
// under `english` and under `simple`. The compiler removes those leaves from that
// config's fragment; without this, `tsv @@ ''::tsquery` is false and `oil and gas`
// would match nothing with no explanation, and `the*` would be a tsquery syntax
// error (a 500).
//
// The SQL is one constant string. The leaves travel as two array parameters.
import type { Queryable } from "../db";
import type { Leaf } from "./ast";

/** Positions, in `leavesOf` order, of the leaves that are empty under each config. */
export type EmptyLeaves = { english: Set<number>; simple: Set<number> };

// A prefix is checked through plainto_tsquery, the function its compiled form
// starts from: if that is empty there is nothing to append `:*` to.
const SQL = `
  SELECT
    l.i::int - 1 AS position,
    numnode(CASE WHEN l.kind = 'phrase'
              THEN phraseto_tsquery('english', l.leaf)
              ELSE plainto_tsquery('english', l.leaf) END) = 0 AS english_empty,
    numnode(CASE WHEN l.kind = 'phrase'
              THEN phraseto_tsquery('simple', l.leaf)
              ELSE plainto_tsquery('simple', l.leaf) END) = 0 AS simple_empty
  FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS l (leaf, kind, i)
  ORDER BY l.i`;

type Row = { position: number; english_empty: boolean; simple_empty: boolean };

export async function findEmptyLeaves(
  db: Queryable,
  leaves: Leaf[],
): Promise<EmptyLeaves> {
  const { rows } = await db.query<Row>(SQL, [
    leaves.map((leaf) => leaf.text),
    leaves.map((leaf) => leaf.type),
  ]);
  const empty: EmptyLeaves = { english: new Set(), simple: new Set() };
  for (const row of rows) {
    if (row.english_empty) empty.english.add(row.position);
    if (row.simple_empty) empty.simple.add(row.position);
  }
  return empty;
}
