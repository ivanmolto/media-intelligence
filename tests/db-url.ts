// The one place the test database URL is resolved, for the global setup and the
// integration tests. Integration tests may only ever run against `media_test`.
export const TEST_DATABASE = "media_test";

const DEFAULT_URL = `postgres://media:media@localhost:5432/${TEST_DATABASE}`;

export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL || DEFAULT_URL;
  const name = new URL(url).pathname.slice(1);
  if (name !== TEST_DATABASE) {
    throw new Error(
      `TEST_DATABASE_URL must name the database "${TEST_DATABASE}", not "${name}". Refusing to run.`,
    );
  }
  return url;
}
