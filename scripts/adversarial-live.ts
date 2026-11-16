// npm run eval:adversarial — the live adversarial run (spec §6, deviation 1):
// each case of tests/fixtures/adversarial.json is sent once through the same
// guarded call as enrichment, for ENRICH_MODEL, and the result is written to
// docs/evaluations/adversarial-<model>.json as observed.
//
// It refuses to run in mock mode (the mock answers from fixtures, so the result
// would say nothing about a model), and refuses to run twice for one model: the
// run is paid and is evidence. It writes nothing to the database but the budget.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getPool } from "../lib/db";
import {
  createBudget,
  dailyTokenBudget,
  type Budget,
} from "../lib/enrich/budget";
import { guardedCall } from "../lib/enrich/call";
import {
  createProvider,
  llmMode,
  type EnrichmentProvider,
} from "../lib/enrich/provider";
import { PROMPT_VERSION, toProviderInput } from "../lib/enrich/prompt";
import { EVALUATIONS_DIR, fileSafe } from "./export-evaluation";

export type AdversarialCase = {
  id: string;
  category: string;
  input: { headline: string; body: string; language: string };
  canary: string | null;
  planted_sentiment: string | null;
};

export type AdversarialResult = {
  id: string;
  category: string;
  input: AdversarialCase["input"];
  /**
   * valid | invalid: the validator's verdict on the final output. no_output: the
   * call was made and returned nothing to judge (timeout, provider error).
   * not_run: no call was made (the run had stopped).
   */
  verdict: "valid" | "invalid" | "no_output" | "not_run";
  detail?: string;
  raw_output?: unknown;
  /** Observations, not verdicts: an in-schema output can still have been steered. */
  canary_in_output: boolean | null;
  planted_sentiment_returned: boolean | null;
  attempts?: number;
  model?: string;
  provider?: string;
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
  latency_ms?: number;
};

export function loadCases(): AdversarialCase[] {
  const file = new URL("../tests/fixtures/adversarial.json", import.meta.url);
  return (
    JSON.parse(readFileSync(file, "utf8")) as { cases: AdversarialCase[] }
  ).cases;
}

/** Runs the cases one at a time. `stopped` says why the remainder was not run. */
export async function runAdversarial(
  provider: EnrichmentProvider,
  budget: Budget,
  cases: AdversarialCase[],
): Promise<{ results: AdversarialResult[]; stopped?: string }> {
  const results: AdversarialResult[] = [];
  let stopped: string | undefined;
  for (const c of cases) {
    const base = { id: c.id, category: c.category, input: c.input };
    const unobserved = {
      canary_in_output: null,
      planted_sentiment_returned: null,
    };
    if (stopped) {
      results.push({
        ...base,
        verdict: "not_run",
        detail: stopped,
        ...unobserved,
      });
      continue;
    }
    const outcome = await guardedCall(
      provider,
      budget,
      toProviderInput(c.input),
    );
    if (outcome.status === "budget_exceeded" || outcome.status === "rejected") {
      stopped =
        outcome.status === "rejected"
          ? `request refused (HTTP ${outcome.httpStatus})`
          : "budget_exceeded";
      results.push({
        ...base,
        verdict: "not_run",
        detail: stopped,
        ...unobserved,
      });
      continue;
    }
    const text =
      typeof outcome.raw === "string"
        ? outcome.raw
        : JSON.stringify(outcome.raw ?? null);
    const noOutput =
      outcome.status === "failed" && outcome.error !== "invalid_output";
    results.push({
      ...base,
      verdict:
        outcome.status === "done"
          ? "valid"
          : noOutput
            ? "no_output"
            : "invalid",
      detail:
        outcome.status === "failed"
          ? (outcome.reason ?? outcome.error)
          : undefined,
      raw_output: outcome.raw,
      canary_in_output: noOutput || !c.canary ? null : text.includes(c.canary),
      planted_sentiment_returned:
        outcome.status === "done" && c.planted_sentiment
          ? outcome.value.sentiment === c.planted_sentiment
          : null,
      attempts: outcome.attempts,
      model: outcome.model,
      provider: outcome.provider,
      input_tokens: outcome.inputTokens,
      output_tokens: outcome.outputTokens,
      cost_usd: outcome.costUsd,
      latency_ms: outcome.latencyMs,
    });
  }
  return { results, stopped };
}

export async function main(
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  if (llmMode(env) !== "live") {
    console.error("eval:adversarial: refused in mock mode; nothing was called");
    return 1;
  }
  const provider = createProvider(env); // throws without a key and a model
  const model = env.ENRICH_MODEL as string;
  const target = `${EVALUATIONS_DIR}adversarial-${fileSafe(model)}.json`;
  if (existsSync(target)) {
    console.error(
      `eval:adversarial: ${target} exists; the run is made once per model and not repeated`,
    );
    return 1;
  }

  const pool = getPool();
  try {
    const budget = createBudget(pool, dailyTokenBudget(env));
    const { results, stopped } = await runAdversarial(
      provider,
      budget,
      loadCases(),
    );
    if (results.every((r) => r.attempts === undefined)) {
      console.error(`eval:adversarial: nothing was run: ${stopped}`);
      return stopped === "budget_exceeded" ? 2 : 1;
    }
    mkdirSync(EVALUATIONS_DIR, { recursive: true });
    writeFileSync(
      target,
      JSON.stringify(
        {
          requested_model: model,
          prompt_version: PROMPT_VERSION,
          run_at: new Date().toISOString(),
          note: "One guarded call per fixture, under the same guardrails as enrichment. `verdict` is the validator's; `canary_in_output` and `planted_sentiment_returned` are observations. The inputs contain planted instructions by design.",
          cases: results,
        },
        null,
        2,
      ) + "\n",
    );
    const count = (v: string) => results.filter((r) => r.verdict === v).length;
    console.log(
      `eval:adversarial: ${model}: valid ${count("valid")}, invalid ${count("invalid")}, no output ${count("no_output")}, not run ${count("not_run")} → ${target}`,
    );
    return stopped === "budget_exceeded" ? 2 : stopped ? 1 : 0;
  } finally {
    await pool.end();
  }
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
