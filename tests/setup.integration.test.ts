import { expect, it } from "vitest";
import { Client } from "pg";
import { testDatabaseUrl } from "./db-url";

it("integration tests run against media_test, created by the global setup", async () => {
  const client = new Client({ connectionString: testDatabaseUrl() });
  await client.connect();
  try {
    const { rows } = await client.query("SELECT current_database() AS name");
    expect(rows[0].name).toBe("media_test");
  } finally {
    await client.end();
  }
});

it("refuses a TEST_DATABASE_URL that names another database", () => {
  const saved = process.env.TEST_DATABASE_URL;
  process.env.TEST_DATABASE_URL = "postgres://media:media@localhost:5432/media";
  try {
    expect(() => testDatabaseUrl()).toThrow(/media_test/);
  } finally {
    if (saved === undefined) delete process.env.TEST_DATABASE_URL;
    else process.env.TEST_DATABASE_URL = saved;
  }
});
