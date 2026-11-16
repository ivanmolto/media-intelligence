// Vitest global setup for the `integration` project only (see vitest.config.ts).
// Unit tests do not run this and pass with the database stopped.
import { Client } from "pg";
import { migrate } from "../scripts/migrate";
import { loadSampleArticles, seed } from "../scripts/seed";
import { TEST_DATABASE, testDatabaseUrl } from "./db-url";

export default async function setup(): Promise<void> {
  const url = testDatabaseUrl();

  // CREATE DATABASE cannot run inside the database it creates: connect to the
  // server's maintenance database with the same credentials.
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const client = new Client({ connectionString: admin.toString() });
  try {
    await client.connect();
  } catch (cause) {
    throw new Error(
      "database not up: start it with `docker compose up -d db`",
      { cause },
    );
  }
  try {
    const found = await client.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [TEST_DATABASE],
    );
    if (found.rowCount === 0) {
      // The name is the constant above; CREATE DATABASE takes no parameter.
      await client.query("CREATE DATABASE media_test");
    }
  } finally {
    await client.end();
  }

  // Migrations and seed, both idempotent, so the suite can run again and again on
  // the same media_test. Test files that write enrichment rows truncate that table
  // when they finish (plan §3, "Test database"); nothing writes `articles` but the seed.
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await migrate(db);
    await seed(db, loadSampleArticles());
  } finally {
    await db.end();
  }
}
