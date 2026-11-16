import { describe, expect, it } from "vitest";
import {
  mockNoFetch,
  noSqlInRoutes,
  noStringBuiltSql,
} from "@/scripts/security-audit";

// The samples are built here, not read from the repo: each rule must fire on a
// violation and stay quiet on clean code.
const lines = (...l: string[]) => l.join("\n");

describe("mock-no-fetch", () => {
  it("flags a fetch call and a network import, with the line", () => {
    const text = lines(
      'import https from "node:https";',
      "export const x = 1;",
      "await fetch(url);",
    );
    expect(mockNoFetch("mock.ts", text).map((f) => f.line)).toEqual([1, 3]);
  });

  it("passes a provider that only reads fixtures", () => {
    const text = lines(
      'import fixtures from "./fixtures.json";',
      "// never calls fetch( anything",
      "export const get = (id: number) => fixtures[id];",
    );
    expect(mockNoFetch("mock.ts", text)).toEqual([]);
  });
});

describe("no-sql-in-routes", () => {
  it("flags a driver import, a query call and a statement", () => {
    const text = lines(
      'import { Pool } from "pg";',
      'import { db } from "@/lib/db";',
      "const r = await pool.query(q);",
      'const q = "select id from articles";',
    );
    expect(
      noSqlInRoutes("app/api/x/route.ts", text).map((f) => f.line),
    ).toEqual([1, 2, 3, 4]);
  });

  it("passes a thin handler", () => {
    const text = lines(
      'import { listArticles } from "@/lib/articles/list";',
      "export async function GET() {",
      "  return Response.json(await listArticles());",
      "}",
    );
    expect(noSqlInRoutes("app/api/x/route.ts", text)).toEqual([]);
  });
});

describe("no-string-built-sql", () => {
  it("flags interpolation into SQL on one line", () => {
    const text =
      "const q = `SELECT * FROM articles WHERE source = '${source}'`;";
    expect(
      noStringBuiltSql("lib/x.ts", text).violations.map((f) => f.line),
    ).toEqual([1]);
  });

  it("flags interpolation on a later line of a multi-line template", () => {
    const text = lines(
      "const q = `",
      "  SELECT id FROM articles",
      "  WHERE source = '${source}'",
      "`;",
    );
    expect(
      noStringBuiltSql("lib/x.ts", text).violations.map((f) => f.line),
    ).toEqual([3]);
  });

  it("flags concatenation into SQL", () => {
    const text =
      'const q = "SELECT id FROM articles WHERE source = \'" + source + "\'";';
    expect(noStringBuiltSql("lib/x.ts", text).violations).toHaveLength(1);
  });

  it("flags a tsquery assembled from a value", () => {
    const text = "const leaf = `tsv @@ to_tsquery('english', '${term}:*')`;";
    expect(noStringBuiltSql("lib/x.ts", text).violations).toHaveLength(1);
  });

  it("passes constant SQL with placeholders and non-SQL templates", () => {
    const text = lines(
      'const q = "SELECT id FROM articles WHERE source = $1 LIMIT $2";',
      "const msg = `page ${n} of ${total}`;",
    );
    expect(noStringBuiltSql("lib/x.ts", text)).toEqual({
      violations: [],
      allowances: [],
    });
  });

  it("reports a marked line as an allowance, with its reason", () => {
    const text = lines(
      "// audit: sql-fragment — n is a placeholder index",
      "const leaf = `tsv @@ plainto_tsquery('english', $${n})`;",
    );
    const result = noStringBuiltSql("lib/x.ts", text);
    expect(result.violations).toEqual([]);
    expect(result.allowances).toEqual([
      {
        rule: "no-string-built-sql",
        file: "lib/x.ts",
        line: 2,
        note: "n is a placeholder index",
      },
    ]);
  });

  it("does not accept a marker without a reason", () => {
    const text = "const leaf = `WHERE id = ${id}`; // audit: sql-fragment";
    expect(noStringBuiltSql("lib/x.ts", text).violations).toHaveLength(1);
  });
});
