import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = { "@": fileURLToPath(new URL(".", import.meta.url)) };

// Two projects, so unit tests never need the database:
// - unit:        tests/**/*.test.ts(x), no global setup
// - integration: tests/**/*.integration.test.ts, against media_test (tests/global-setup.ts)
export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          include: ["tests/**/*.test.{ts,tsx}"],
          exclude: ["tests/**/*.integration.test.ts"],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "integration",
          include: ["tests/**/*.integration.test.ts"],
          globalSetup: ["tests/global-setup.ts"],
          fileParallelism: false,
        },
      },
    ],
  },
});
