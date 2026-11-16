// Guardrails that are SQL (spec §3): the atomic budget reservation, the claim
// with FOR UPDATE SKIP LOCKED, dedup, and the worker's exit codes. Against
// media_test; every test starts from empty enrichment and budget tables.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createBudget } from "@/lib/enrich/budget";
import { MockProvider } from "@/lib/enrich/mock";
import {
  ProviderError,
  type EnrichmentProvider,
  type ProviderResult,
  type RunKey,
} from "@/lib/enrich/provider";
import { claim, enqueue, enrichCommand, runWorker } from "@/lib/enrich/worker";
import { testDatabaseUrl } from "./db-url";

const db = new Pool({ connectionString: testDatabaseUrl() });
const MOCK: RunKey = {
  requestedModel: "mock",
  promptVersion: "v1",
  taxonomyVersion: "v1",
};

const clean = () => db.query("TRUNCATE article_enrichments, enrichment_budget");
beforeEach(clean);
afterAll(async () => {
  await clean();
  await db.end();
});

/** Wraps a provider and counts its calls. */
function counting(inner: EnrichmentProvider) {
  let calls = 0;
  const provider: EnrichmentProvider = {
    enrich(input, opts) {
      calls++;
      return inner.enrich(input, opts);
    },
  };
  return { provider, calls: () => calls };
}

const always = (result: ProviderResult | Error): EnrichmentProvider => ({
  enrich: () =>
    result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
});

const statuses = async (): Promise<Record<string, number>> => {
  const { rows } = await db.query<{ status: string; n: string }>(
    "SELECT status, count(*) AS n FROM article_enrichments GROUP BY status",
  );
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
};

const tokensUsed = async (): Promise<number> => {
  const { rows } = await db.query<{ used: string }>(
    "SELECT coalesce(sum(tokens_used), 0) AS used FROM enrichment_budget",
  );
  return Number(rows[0]?.used);
};

const run = async (
  env: Record<string, string>,
  args: string[] = [],
  provider?: EnrichmentProvider,
) => {
  const lines: string[] = [];
  const code = await enrichCommand(db, env, args, {
    provider,
    log: (line) => lines.push(line),
  });
  return { code, output: lines.join("\n") };
};

describe("daily budget", () => {
  const day = () => new Date("2031-05-06T23:59:00Z");

  it("creates the day's row and reserves against it", async () => {
    const budget = createBudget(db, 1000, day);
    expect(await budget.reserve(400)).toEqual({
      day: "2031-05-06",
      tokens: 400,
    });
    expect(await budget.reserve(600)).not.toBeNull(); // exactly the limit
    expect(await budget.reserve(1)).toBeNull();
    expect(await tokensUsed()).toBe(1000);
  });

  it("cannot be passed by concurrent reservations", async () => {
    const budget = createBudget(db, 1000, day);
    const results = await Promise.all(
      Array.from({ length: 50 }, () => budget.reserve(100)),
    );
    expect(results.filter(Boolean)).toHaveLength(10);
    expect(await tokensUsed()).toBe(1000);
  });

  it("corrects a reservation to the reported tokens, up or down", async () => {
    const budget = createBudget(db, 1000, day);
    const a = await budget.reserve(500);
    const b = await budget.reserve(500);
    if (!a || !b) throw new Error("reservation refused");
    await budget.correct(a, 120);
    await budget.correct(b, 530);
    expect(await tokensUsed()).toBe(650);
    expect(await budget.reserve(350)).not.toBeNull();
  });

  it("is per UTC day", async () => {
    await createBudget(db, 100, day).reserve(100);
    const next = createBudget(db, 100, () => new Date("2031-05-07T00:00:01Z"));
    expect(await next.reserve(100)).not.toBeNull();
  });
});

describe("claim", () => {
  it("hands each pending row to one claimer only", async () => {
    await enqueue(db, MOCK);
    const claims = await Promise.all(
      Array.from({ length: 30 }, () => claim(db, MOCK)),
    );
    const ids = claims.filter((c) => c !== null).map((c) => c.id);
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
    expect(await statuses()).toEqual({ processing: 20 });
  });

  it("takes back a row left processing for more than 10 minutes, not a fresh one", async () => {
    await enqueue(db, MOCK);
    await db.query(
      "UPDATE article_enrichments SET status = 'processing', claimed_at = now() - interval '1 minute'",
    );
    expect(await claim(db, MOCK)).toBeNull();
    await db.query(
      `UPDATE article_enrichments SET claimed_at = now() - interval '11 minutes'
        WHERE article_id = (SELECT id FROM articles WHERE external_id = 7)`,
    );
    const taken = await claim(db, MOCK);
    expect(taken).not.toBeNull();
    expect(await claim(db, MOCK)).toBeNull();
  });

  it("leaves other run keys alone", async () => {
    await enqueue(db, { ...MOCK, requestedModel: "other" });
    expect(await claim(db, MOCK)).toBeNull();
  });
});

describe("npm run enrich", () => {
  it("mock: 20 done rows, recorded from the response, and the budget charged", async () => {
    const { code } = await run({});
    expect(code).toBe(0);
    const { rows } = await db.query<{
      n: string;
      tokens: string;
      hashes: string;
    }>(
      `SELECT count(*) AS n, sum(e.input_tokens + e.output_tokens) AS tokens,
              count(*) FILTER (WHERE e.content_hash = a.content_hash) AS hashes
         FROM article_enrichments e JOIN articles a ON a.id = e.article_id
        WHERE e.requested_model = 'mock' AND e.status = 'done' AND e.attempts = 1
          AND e.model = 'mock' AND e.provider = 'mock' AND e.cost_usd IS NULL
          AND e.sentiment IS NOT NULL AND e.summary IS NOT NULL
          AND cardinality(e.tags) BETWEEN 1 AND 3 AND e.claimed_at IS NULL`,
    );
    expect(Number(rows[0]?.n)).toBe(20);
    expect(Number(rows[0]?.hashes)).toBe(20);
    expect(await tokensUsed()).toBe(Number(rows[0]?.tokens));
  });

  it("a re-run calls nothing and charges nothing", async () => {
    await run({});
    const used = await tokensUsed();
    const { provider, calls } = counting(new MockProvider());
    expect((await run({}, [], provider)).code).toBe(0);
    expect(calls()).toBe(0);
    expect(await tokensUsed()).toBe(used);
  });

  it("invalid output fails the row after one retry, with no sentiment, and a re-run leaves it failed", async () => {
    const bad = always({
      raw: { summary: "x", sentiment: "neutral", tags: ["other"] },
      model: "m",
      provider: "p",
      inputTokens: 10,
      outputTokens: 5,
    });
    expect((await run({}, [], bad)).code).toBe(0);
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM article_enrichments
        WHERE status = 'failed' AND error = 'invalid_output' AND attempts = 2
          AND sentiment IS NULL AND summary IS NULL AND tags IS NULL
          AND input_tokens = 20 AND output_tokens = 10`,
    );
    expect(Number(rows[0]?.n)).toBe(20);

    const { provider, calls } = counting(new MockProvider());
    expect((await run({}, [], provider)).code).toBe(0);
    expect(calls()).toBe(0);
    expect(await statuses()).toEqual({ failed: 20 });
  });

  it("--force re-processes every row in mock mode", async () => {
    await run({});
    const { provider, calls } = counting(new MockProvider());
    expect((await run({}, ["--force"], provider)).code).toBe(0);
    expect(calls()).toBe(20);
    expect(await statuses()).toEqual({ done: 20 });
  });

  it("--force is refused in live mode before anything is touched", async () => {
    await run({});
    const { provider, calls } = counting(new MockProvider());
    const live = {
      LLM_MODE: "live",
      ENRICH_MODEL: "vendor/model",
      OPENROUTER_API_KEY: "k",
    };
    const { code, output } = await run(live, ["--force"], provider);
    expect(code).toBe(1);
    expect(output).toContain("--force is refused");
    expect(calls()).toBe(0);
    expect(await statuses()).toEqual({ done: 20 }); // the mock rows, untouched
  });

  it("stops with exit 2 when the budget runs out, and a later run finishes", async () => {
    const stopped = await run({ DAILY_TOKEN_BUDGET: "1000" });
    expect(stopped.code).toBe(2);
    expect(stopped.output).toContain("budget_exceeded");
    const after = await statuses();
    expect(after.processing).toBeUndefined();
    expect(after.pending).toBeGreaterThan(0);
    expect((after.done ?? 0) + after.pending!).toBe(20);
    expect(await tokensUsed()).toBeLessThanOrEqual(1000);

    expect((await run({})).code).toBe(0); // the default budget; no --force
    expect(await statuses()).toEqual({ done: 20 });
  });

  it("a refused request (4xx) stops the run, fails no row and charges nothing", async () => {
    const { provider, calls } = counting(always(new ProviderError(401)));
    const { code, output } = await run(
      { ENRICH_CONCURRENCY: "1" },
      [],
      provider,
    );
    expect(code).toBe(1);
    expect(output).toContain("HTTP 401");
    expect(calls()).toBe(1);
    expect(await statuses()).toEqual({ pending: 20 });
    expect(await tokensUsed()).toBe(0);
  });

  it("copies a done row with the same content hash instead of calling", async () => {
    await enqueue(db, MOCK);
    // Article 1's row is made `done` under article 2's hash: the state a duplicate
    // of article 2, enriched earlier, would have left.
    await db.query(
      `UPDATE article_enrichments e
          SET status = 'done', summary = 'A summary copied from an earlier duplicate.',
              sentiment = 'mixed', tags = ARRAY['other'], model = 'm', provider = 'p',
              input_tokens = 300, output_tokens = 40, latency_ms = 900,
              cost_usd = 0.01, attempts = 2,
              content_hash = (SELECT content_hash FROM articles WHERE external_id = 2)
        WHERE e.article_id = (SELECT id FROM articles WHERE external_id = 1)`,
    );
    const { provider, calls } = counting(new MockProvider());
    const result = await runWorker(db, provider, createBudget(db, 1e6), MOCK);
    expect(result).toMatchObject({ done: 19, copied: 1, failed: 0 });
    expect(calls()).toBe(18);

    const { rows } = await db.query(
      `SELECT e.summary, e.sentiment, e.tags, e.model, e.provider, e.input_tokens,
              e.output_tokens, e.latency_ms, e.cost_usd, e.attempts, e.status
         FROM article_enrichments e JOIN articles a ON a.id = e.article_id
        WHERE a.external_id = 2`,
    );
    expect(rows[0]).toEqual({
      summary: "A summary copied from an earlier duplicate.",
      sentiment: "mixed",
      tags: ["other"],
      model: "m",
      provider: "p",
      input_tokens: null,
      output_tokens: null,
      latency_ms: null,
      cost_usd: null,
      attempts: null,
      status: "done",
    });
  });
});
