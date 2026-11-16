// npm run migrate — applies db/migrations/*.sql in name order, once each.
// Idempotent: applied files are recorded in schema_migrations and skipped.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const MIGRATIONS_DIR = fileURLToPath(
  new URL("../db/migrations", import.meta.url),
);
// Any constant: two `init` containers starting together must not both apply a file.
const LOCK_KEY = 7462001;

/** Applies the pending migrations and returns their file names. */
export async function migrate(client: Client): Promise<string[]> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const applied: string[] = [];

  await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
  try {
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const { rows } = await client.query<{ name: string }>(
      "SELECT name FROM schema_migrations",
    );
    const done = new Set(rows.map((row) => row.name));

    for (const name of files) {
      if (done.has(name)) continue;
      // The file is a constant from the repo, sent as-is; it takes no parameters.
      const sql = readFileSync(join(MIGRATIONS_DIR, name), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [
          name,
        ]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      applied.push(name);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
  }
  return applied;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const applied = await migrate(client);
    console.log(
      applied.length === 0
        ? "migrate: nothing to apply"
        : "migrate: applied " + applied.join(", "),
    );
  } finally {
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
