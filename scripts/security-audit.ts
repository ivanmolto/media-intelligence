// npm run security-audit — the three deterministic rules of plan §2 (deviation 9):
//
//   mock-no-fetch        lib/enrich/mock.ts makes no network call
//   no-sql-in-routes     app/**/route.ts(x) holds no SQL and no database access
//   no-string-built-sql  no SQL text mixed with an interpolated or concatenated value
//
// Every violation is printed as `FAIL  <rule>  <file>:<line>`; any violation exits 1.
// A path that does not exist yet is printed as NOT CHECKED, so an early green run is
// not read as evidence.
//
// Limits. The rules are line-based regular expressions, not a parser:
// - a template literal nested inside `${…}` can hide the rest of the outer one;
// - SQL keywords are matched in upper case only, apart from whole statements;
// - a line that builds SQL from constants and `$n` placeholders must carry
//   `// audit: sql-fragment — <reason>` on that line or the line above. Every such
//   allowance is printed, so the security-audit skill's traced check reviews each one.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type Finding = {
  rule: string;
  file: string;
  line: number;
  note?: string;
};
export type Result = { violations: Finding[]; allowances: Finding[] };

const MOCK_PROVIDER = "lib/enrich/mock.ts";
const ROUTE_ROOT = "app";
const SOURCE_ROOTS = ["app", "lib", "components", "scripts"];
const SOURCE_FILE = /\.(ts|tsx|mts|js|jsx|mjs)$/;
const ROUTE_FILE = /(^|\/)route\.tsx?$/;

const NETWORK_CALL = /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\s*\(/;
const NETWORK_IMPORT =
  /(from\s+|import\s*\(\s*|require\s*\(\s*)["'](node:)?(http|https|http2|net|tls|dgram|undici|axios|node-fetch|got)["']/;

const DB_IMPORT =
  /(from\s+|import\s*\(\s*|require\s*\(\s*)["'](pg|[^"']*lib\/db)["']/;
const QUERY_CALL = /\.query\s*\(/;
const SQL_STATEMENT =
  /\bSELECT\b[^;]*\bFROM\b|\bINSERT\s+INTO\b|\bUPDATE\s+\w+\s+SET\b|\bDELETE\s+FROM\b|\b(CREATE|ALTER|DROP)\s+(TABLE|INDEX|DATABASE)\b|\bTRUNCATE\s+\w/i;
const SQL_FRAGMENT =
  /\b(WHERE|ORDER BY|GROUP BY|LIMIT|OFFSET|JOIN|VALUES|RETURNING|ON CONFLICT)\b|@@|\w*tsquery\s*\(|::tsquery|\btsvector\b/;
const CONCATENATION = /["'`]\s*\+|\+\s*["'`]/;
const MARKER = /\/\/\s*audit:\s*sql-fragment\b(.*)$/;

const isSql = (text: string): boolean =>
  SQL_STATEMENT.test(text) || SQL_FRAGMENT.test(text);

// Comment lines are blanked, not removed, so line numbers still match the file.
function codeLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? "" : line));
}

export function mockNoFetch(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  codeLines(text).forEach((line, i) => {
    if (NETWORK_CALL.test(line) || NETWORK_IMPORT.test(line)) {
      out.push({ rule: "mock-no-fetch", file, line: i + 1 });
    }
  });
  return out;
}

export function noSqlInRoutes(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  codeLines(text).forEach((line, i) => {
    if (
      DB_IMPORT.test(line) ||
      QUERY_CALL.test(line) ||
      SQL_STATEMENT.test(line)
    ) {
      out.push({ rule: "no-sql-in-routes", file, line: i + 1 });
    }
  });
  return out;
}

export function noStringBuiltSql(file: string, text: string): Result {
  const rule = "no-string-built-sql";
  const raw = text.split("\n");
  const lines = codeLines(text);
  const suspect = new Set<number>(); // 0-based line indexes

  // Template literals, taken whole: SQL on one line and `${…}` on another still counts.
  const code = lines.join("\n");
  const template = /`[^`]*`/g;
  for (let m = template.exec(code); m; m = template.exec(code)) {
    if (!isSql(m[0]) || !m[0].includes("${")) continue;
    const first = code.slice(0, m.index).split("\n").length - 1;
    m[0].split("\n").forEach((part, offset) => {
      if (part.includes("${")) suspect.add(first + offset);
    });
  }
  // String concatenation on a line that holds SQL text.
  lines.forEach((line, i) => {
    if (CONCATENATION.test(line) && isSql(line)) suspect.add(i);
  });

  const result: Result = { violations: [], allowances: [] };
  for (const i of [...suspect].sort((a, b) => a - b)) {
    const marker = MARKER.exec(raw[i] ?? "") ?? MARKER.exec(raw[i - 1] ?? "");
    const reason = marker?.[1]?.replace(/^[\s—:-]+/, "").trim();
    if (reason)
      result.allowances.push({ rule, file, line: i + 1, note: reason });
    else result.violations.push({ rule, file, line: i + 1 });
  }
  return result;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules" || name.startsWith(".")) return [];
    return statSync(path).isDirectory()
      ? walk(path)
      : SOURCE_FILE.test(name)
        ? [path]
        : [];
  });
}

function main(): number {
  const violations: Finding[] = [];
  const read = (file: string) => readFileSync(file, "utf8");

  // 1. mock-no-fetch
  if (existsSync(MOCK_PROVIDER)) {
    const found = mockNoFetch(MOCK_PROVIDER, read(MOCK_PROVIDER));
    violations.push(...found);
    if (found.length === 0)
      console.log(`PASS  mock-no-fetch  ${MOCK_PROVIDER}`);
  } else {
    console.log(`NOT CHECKED  mock-no-fetch  ${MOCK_PROVIDER} does not exist`);
  }

  // 2. no-sql-in-routes
  const routes = existsSync(ROUTE_ROOT)
    ? walk(ROUTE_ROOT).filter((f) => ROUTE_FILE.test(f))
    : [];
  if (routes.length > 0) {
    const found = routes.flatMap((f) => noSqlInRoutes(f, read(f)));
    violations.push(...found);
    if (found.length === 0) {
      console.log(
        `PASS  no-sql-in-routes  ${routes.length} route file(s): ${routes.join(", ")}`,
      );
    }
  } else {
    console.log(
      `NOT CHECKED  no-sql-in-routes  no route file under ${ROUTE_ROOT}/`,
    );
  }

  // 3. no-string-built-sql
  const roots = SOURCE_ROOTS.filter((dir) => existsSync(dir));
  for (const dir of SOURCE_ROOTS.filter((d) => !roots.includes(d))) {
    console.log(`NOT CHECKED  no-string-built-sql  ${dir}/ does not exist`);
  }
  const sources = roots.flatMap(walk);
  let built = 0;
  for (const file of sources) {
    const result = noStringBuiltSql(file, read(file));
    built += result.violations.length;
    violations.push(...result.violations);
    for (const a of result.allowances) {
      console.log(`ALLOWED  ${a.rule}  ${a.file}:${a.line}  ${a.note}`);
    }
  }
  if (sources.length > 0 && built === 0) {
    console.log(
      `PASS  no-string-built-sql  ${sources.length} file(s) under ${roots.join(", ")}`,
    );
  }

  for (const v of violations)
    console.log(`FAIL  ${v.rule}  ${v.file}:${v.line}`);
  console.log(
    violations.length === 0
      ? "security-audit: no violations"
      : `security-audit: ${violations.length} violation(s)`,
  );
  return violations.length === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
