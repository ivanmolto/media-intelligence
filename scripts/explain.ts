// npm run db:explain — runs EXPLAIN (ANALYZE, BUFFERS) for every case in
// scripts/explain-queries.json against the synthetic database and writes the plans
// to docs/evaluations/explain.txt (deviation 6). The pg-explain skill reads that file.
//
// The statements are the app's own. Each case is parsed by lib/api/params, searched
// by lib/search and handed to listArticles / aggregateArticles, exactly as
// lib/api/handlers does, except that the function gets a `Queryable` that puts
// EXPLAIN in front of whatever statement it is given. This file writes no list,
// search or aggregate SQL. Its own SQL only resolves the `@` placeholders, counts
// the rows a case matches, and reads the header facts.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client, type QueryResult, type QueryResultRow } from "pg";
import { parseAggregateParams, parseListParams } from "../lib/api/params";
import { aggregateArticles } from "../lib/articles/aggregate";
import {
  type ArticleFilters,
  buildFrom,
  buildWhere,
  Params,
  type RunKey,
} from "../lib/articles/filters";
import { listArticles } from "../lib/articles/list";
import type { Queryable } from "../lib/db";
import { activeRunKey } from "../lib/enrich/provider";
import { prepareSearch } from "../lib/search/compile";
import { syntheticDatabaseUrl } from "./synthetic";

const QUERIES_FILE = new URL("./explain-queries.json", import.meta.url);
const OUTPUT_FILE = new URL("../docs/evaluations/explain.txt", import.meta.url);
const OUTPUT_PATH = "docs/evaluations/explain.txt";

type Case = {
  id: string;
  endpoint: "list" | "aggregate";
  params: Record<string, string>;
  index: string | null;
};

type Captured = { sql: string; values: unknown[]; plan: string[] };

/** Runs the statement it is given under EXPLAIN and keeps the plan; returns no rows. */
function explaining(db: Queryable, captured: Captured[]): Queryable {
  return {
    async query<R extends QueryResultRow>(text: string, values?: unknown[]) {
      // The statement and its parameter array are passed on untouched.
      const result = await db.query<{ "QUERY PLAN": string }>(
        "EXPLAIN (ANALYZE, BUFFERS) " + text,
        values,
      );
      captured.push({
        sql: text,
        values: values ?? [],
        plan: result.rows.map((row) => row["QUERY PLAN"]),
      });
      return { rows: [], rowCount: 0 } as unknown as QueryResult<R>;
    },
  };
}

/** The filters of a case, with the search compiled, as lib/api/handlers does it. */
async function filtersOf(
  db: Queryable,
  parsed: { q?: string; filters: Omit<ArticleFilters, "search"> },
): Promise<ArticleFilters> {
  if (parsed.q === undefined) return parsed.filters;
  const { fragment } = await prepareSearch(db, parsed.q);
  return { ...parsed.filters, search: fragment };
}

async function explainCase(
  db: Queryable,
  runKey: RunKey,
  testCase: Case,
  params: Record<string, string>,
): Promise<Captured> {
  const query = new URLSearchParams(params);
  const captured: Captured[] = [];
  const explain = explaining(db, captured);
  if (testCase.endpoint === "list") {
    const parsed = parseListParams(query);
    const filters = await filtersOf(db, parsed);
    await listArticles(explain, {
      filters,
      runKey,
      cursor: parsed.cursor,
      limit: parsed.limit,
    });
  } else {
    const parsed = parseAggregateParams(query);
    const filters = await filtersOf(db, parsed);
    await aggregateArticles(explain, {
      filters,
      runKey,
      bucket: parsed.bucket,
      groupBy: parsed.groupBy,
    });
  }
  const only = captured[0];
  if (captured.length !== 1 || !only) {
    throw new Error(
      `${testCase.id}: expected one statement, got ${captured.length}`,
    );
  }
  return only;
}

/** How many articles the case's filters match, cursor and limit aside. */
async function matchingRows(
  db: Queryable,
  runKey: RunKey,
  params: Record<string, string>,
): Promise<number> {
  const filters = await filtersOf(
    db,
    parseListParams(new URLSearchParams({ ...params, cursor: "" })),
  );
  const values = new Params();
  const from = buildFrom(runKey, values);
  const where = buildWhere(filters, values);
  const sql = [
    "SELECT count(*)::int AS count",
    from,
    "WHERE " + where, // audit: sql-fragment — conditions are constants and $n placeholders from filters.ts
  ].join("\n");
  const { rows } = await db.query<{ count: number }>(sql, values.values);
  return rows[0]?.count ?? 0;
}

/** Replaces the `@` placeholders of a case (see the queries file's `about`). */
async function resolve(
  db: Queryable,
  runKey: RunKey,
  testCase: Case,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(testCase.params)) {
    if (!value.startsWith("@")) {
      out[name] = value;
    } else if (value === "@sample" && name === "source") {
      // "a value that exists": the first in sort order
      const { rows } = await db.query<{ value: string }>(
        "SELECT min(source) AS value FROM articles",
      );
      out[name] = rows[0]?.value ?? "";
    } else if (value === "@sample" && name === "topic") {
      const { rows } = await db.query<{ value: string }>(
        `SELECT min(tag) AS value
           FROM article_enrichments e, unnest(e.tags) AS tag
          WHERE e.requested_model = $1 AND e.prompt_version = $2 AND e.taxonomy_version = $3`,
        [runKey.requestedModel, runKey.promptVersion, runKey.taxonomyVersion],
      );
      out[name] = rows[0]?.value ?? "";
    } else if (value === "@month-start" || value === "@month-end") {
      // the first whole calendar month after the earliest article
      const { rows } = await db.query<{ first: string; last: string }>(
        `SELECT to_char(m, 'YYYY-MM-DD') AS first,
                to_char(m + interval '1 month' - interval '1 day', 'YYYY-MM-DD') AS last
           FROM (SELECT date_trunc('month', min(published_at) AT TIME ZONE 'UTC')
                        + interval '1 month' AS m
                   FROM articles) AS month`,
      );
      out[name] =
        (value === "@month-start" ? rows[0]?.first : rows[0]?.last) ?? "";
    } else if (value === "@page-50" && name === "cursor") {
      continue; // needs the other params first; resolved below
    } else {
      throw new Error(`${testCase.id}: cannot resolve ${name}=${value}`);
    }
    if (out[name] === "") {
      throw new Error(`${testCase.id}: no data to resolve ${name}=${value}`);
    }
  }
  if (testCase.params.cursor === "@page-50") {
    // Page 49 times with the app's own list; the cursor then points at page 50.
    const parsed = parseListParams(new URLSearchParams(out));
    const filters = await filtersOf(db, parsed);
    let cursor: string | undefined;
    for (let page = 1; page <= 49; page++) {
      const { nextCursor } = await listArticles(db, {
        filters,
        runKey,
        cursor,
        limit: parsed.limit,
      });
      if (nextCursor === null) {
        throw new Error(`${testCase.id}: the data ends before page 50`);
      }
      cursor = nextCursor;
    }
    out.cursor = cursor as string;
  }
  return out;
}

const INDEX_SCAN =
  /(?:Index (?:Only )?Scan(?: Backward)? using|Bitmap Index Scan on) (\w+)/g;

function indexesIn(plan: string[]): string[] {
  const names = [...plan.join("\n").matchAll(INDEX_SCAN)].map((m) => m[1]);
  return [...new Set(names)] as string[];
}

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trimEnd();
}

async function main(): Promise<void> {
  const url = syntheticDatabaseUrl();
  const runKey = activeRunKey();
  const { cases } = JSON.parse(readFileSync(QUERIES_FILE, "utf8")) as {
    cases: Case[];
  };

  const client = new Client({ connectionString: url });
  await client.connect();
  const lines: string[] = [];
  let run = 0;
  try {
    const version = await client.query<{ version: string }>(
      "SELECT version() AS version",
    );
    const total = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM articles",
    );
    const articles = total.rows[0]?.count ?? 0;
    // The output file itself is left out: writing it must not make the tree dirty.
    const status = git("status", "--porcelain", "--", ".", ":!" + OUTPUT_PATH);

    lines.push(
      "EXPLAIN (ANALYZE, BUFFERS) on the synthetic database — written by `npm run db:explain`",
      "",
      "generated:    " + new Date().toISOString(),
      "postgres:     " + (version.rows[0]?.version ?? "unknown"),
      "database:     " + new URL(url).pathname.slice(1),
      "articles:     " + articles,
      `run key:      ${runKey.requestedModel} / ${runKey.promptVersion} / ${runKey.taxonomyVersion}`,
      "commit:       " + git("rev-parse", "HEAD"),
      "working tree: " + (status === "" ? "clean" : "dirty"),
      ...(status === ""
        ? []
        : status.split("\n").map((l) => "              " + l)),
      "queries:      scripts/explain-queries.json",
      "",
      "Each case is run twice; the second run is recorded, so buffers are warm.",
      "Synthetic text: term frequencies are set in scripts/synthetic.ts (RATES), not",
      "taken from a corpus. Timings describe this dataset on this machine.",
    );

    for (const testCase of cases) {
      const params = await resolve(client, runKey, testCase);
      const matching = await matchingRows(client, runKey, params);
      await explainCase(client, runKey, testCase, params);
      const second = await explainCase(client, runKey, testCase, params);
      const used = indexesIn(second.plan);
      lines.push(
        "",
        "=".repeat(78),
        "case:            " + testCase.id,
        "endpoint:        " + testCase.endpoint,
        "params:          " + JSON.stringify(params),
        "intended index:  " +
          (testCase.index ?? "none (a full read is expected)"),
        "indexes in plan: " + (used.length === 0 ? "none" : used.join(", ")),
        `matching rows:   ${matching} of ${articles} (filters only; cursor and limit aside)`,
        "",
        "statement:",
        ...second.sql.split("\n").map((l) => "  " + l),
        "parameters:      " + JSON.stringify(second.values),
        "",
        ...second.plan,
      );
      run += 1;
      console.log(
        `explain: ${testCase.id}: ${used.length === 0 ? "no index" : used.join(", ")}; ${matching} matching`,
      );
    }
    lines.push(
      "",
      "=".repeat(78),
      `cases in file: ${cases.length}; cases run: ${run}`,
    );
  } finally {
    await client.end();
  }

  writeFileSync(OUTPUT_FILE, lines.join("\n") + "\n");
  console.log(
    `explain: wrote ${OUTPUT_PATH} (${run} of ${cases.length} cases)`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
