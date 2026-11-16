// The one place the app's connection pool is created. Query functions under lib/
// take a `Queryable` argument instead of importing the pool, so tests pass the
// media_test database and the scale scripts pass the synthetic one.
import { Pool, type QueryResult, type QueryResultRow } from "pg";

export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    pool = new Pool({ connectionString: url });
  }
  return pool;
}
