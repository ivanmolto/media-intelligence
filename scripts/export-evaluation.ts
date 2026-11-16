// npm run eval:export [-- --mock-fixtures] — writes the article_enrichments rows
// of ENRICH_MODEL to docs/evaluations/enrichments-<model>.json, as they are (spec
// S11). It reads the database only and calls no provider.
//
// With --mock-fixtures it also rewrites tests/fixtures/mock-enrichments.json from
// the same rows, token counts included, so the mock replays that model's run.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getPool } from "../lib/db";
import {
  inputKey,
  MOCK_FIXTURES_URL,
  type MockFixtureFile,
} from "../lib/enrich/mock";
import { readOnlyRunKey } from "../lib/enrich/provider";
import { toProviderInput } from "../lib/enrich/prompt";

export const EVALUATIONS_DIR = fileURLToPath(
  new URL("../docs/evaluations/", import.meta.url),
);

/** A model id as a file name: `/` and anything else outside [A-Za-z0-9._-] → `-`. */
export const fileSafe = (model: string): string =>
  model.replace(/[^A-Za-z0-9._-]/g, "-");

type Row = {
  external_id: number;
  headline: string;
  body: string;
  language: string;
  status: string;
  summary: string | null;
  sentiment: string | null;
  tags: string[] | null;
  model: string | null;
  provider: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number | null;
  cost_usd: string | null;
  attempts: number | null;
  error: string | null;
  updated_at: Date;
};

async function main(): Promise<number> {
  if (!process.env.ENRICH_MODEL) {
    console.error("eval:export: set ENRICH_MODEL to the model id to export");
    return 1;
  }
  const key = readOnlyRunKey();
  const pool = getPool();
  const { rows } = await pool
    .query<Row>(
      `SELECT a.external_id, a.headline, a.body, a.language,
              e.status, e.summary, e.sentiment, e.tags, e.model, e.provider,
              e.input_tokens, e.output_tokens, e.latency_ms, e.cost_usd,
              e.attempts, e.error, e.updated_at
         FROM article_enrichments e JOIN articles a ON a.id = e.article_id
        WHERE e.requested_model = $1 AND e.prompt_version = $2 AND e.taxonomy_version = $3
        ORDER BY a.external_id`,
      [key.requestedModel, key.promptVersion, key.taxonomyVersion],
    )
    .finally(() => pool.end());
  if (rows.length === 0) {
    console.error(`eval:export: no rows for ${key.requestedModel}`);
    return 1;
  }

  mkdirSync(EVALUATIONS_DIR, { recursive: true });
  const target = `${EVALUATIONS_DIR}enrichments-${fileSafe(key.requestedModel)}.json`;
  const snapshot = {
    run_key: key,
    exported_at: new Date().toISOString(),
    rows: rows.map((r) => ({
      external_id: r.external_id,
      status: r.status,
      summary: r.summary,
      sentiment: r.sentiment,
      tags: r.tags,
      model: r.model,
      provider: r.provider,
      input_tokens: r.input_tokens,
      output_tokens: r.output_tokens,
      latency_ms: r.latency_ms,
      cost_usd: r.cost_usd,
      attempts: r.attempts,
      error: r.error,
      updated_at: r.updated_at,
    })),
  };
  writeFileSync(target, JSON.stringify(snapshot, null, 2) + "\n");
  console.log(`eval:export: ${rows.length} rows → ${target}`);

  if (process.argv.includes("--mock-fixtures")) {
    const notDone = rows.filter((r) => r.status !== "done");
    if (notDone.length > 0) {
      // The mock can replay an output, not a failure: a human decides what the
      // default path shows for these articles.
      console.error(
        `eval:export: mock fixtures not written: ${notDone.length} row(s) are not done (articles ${notDone.map((r) => r.external_id).join(", ")})`,
      );
      return 1;
    }
    const last = rows.reduce((a, b) => (a.updated_at > b.updated_at ? a : b));
    const file: MockFixtureFile = {
      provenance: "live",
      model: key.requestedModel,
      run_date: last.updated_at.toISOString().slice(0, 10),
      note: "Recorded output of the live run named above, exported by `npm run eval:export -- --mock-fixtures`; token counts are the provider-reported ones (summed when a row took a retry). `key` is the hash of the provider input (lib/enrich/mock.ts).",
      fixtures: rows.map((r) => ({
        external_id: r.external_id,
        key: inputKey(toProviderInput(r)),
        output: { summary: r.summary, sentiment: r.sentiment, tags: r.tags },
        input_tokens: r.input_tokens ?? 0,
        output_tokens: r.output_tokens ?? 0,
      })),
    };
    writeFileSync(MOCK_FIXTURES_URL, JSON.stringify(file, null, 2) + "\n");
    console.log(`eval:export: mock fixtures ← ${key.requestedModel}`);
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
