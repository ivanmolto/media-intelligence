// The enrichment worker (spec §3), for one run key: enqueue, claim, process.
// One-shot and safe to re-run: only `pending` rows are processed; `done` rows are
// skipped and `failed` rows are left as they are.
import type { Queryable } from "../db";
import { createBudget, dailyTokenBudget, type Budget } from "./budget";
import { guardedCall } from "./call";
import {
  activeRunKey,
  createProvider,
  llmMode,
  type EnrichmentProvider,
  type RunKey,
} from "./provider";
import { toProviderInput } from "./prompt";

export const DEFAULT_CONCURRENCY = 3;

export type WorkerResult = {
  done: number;
  failed: number;
  /** `done` rows copied from a row with the same content hash, without a call. */
  copied: number;
  budgetExceeded: boolean;
  /** HTTP status, when the provider refused a request and the run stopped. */
  rejected?: number;
};

type Claimed = {
  id: string;
  headline: string;
  body: string;
  language: string;
  content_hash: Buffer;
};

const params = (key: RunKey) => [
  key.requestedModel,
  key.promptVersion,
  key.taxonomyVersion,
];

/** A `pending` row for every article that has none for this run key. */
export async function enqueue(db: Queryable, key: RunKey): Promise<number> {
  const result = await db.query(
    `INSERT INTO article_enrichments
       (article_id, requested_model, prompt_version, taxonomy_version, status, updated_at)
     SELECT id, $1, $2, $3, 'pending', now() FROM articles
     ON CONFLICT DO NOTHING`,
    params(key),
  );
  return result.rowCount ?? 0;
}

/** `--force`: every row of the run key back to `pending`, results cleared. */
export async function resetRunKey(db: Queryable, key: RunKey): Promise<number> {
  const result = await db.query(
    `UPDATE article_enrichments
        SET status = 'pending', claimed_at = NULL, content_hash = NULL,
            summary = NULL, sentiment = NULL, tags = NULL, model = NULL,
            provider = NULL, input_tokens = NULL, output_tokens = NULL,
            latency_ms = NULL, cost_usd = NULL, attempts = NULL, error = NULL,
            updated_at = now()
      WHERE requested_model = $1 AND prompt_version = $2 AND taxonomy_version = $3`,
    params(key),
  );
  return result.rowCount ?? 0;
}

/**
 * Claims one row: `pending`, or `processing` for more than 10 minutes (a worker
 * that died). One statement, so the claim is atomic; SKIP LOCKED lets concurrent
 * claimers pass over a row another is taking instead of waiting for it.
 */
export async function claim(
  db: Queryable,
  key: RunKey,
): Promise<Claimed | null> {
  const result = await db.query<Claimed>(
    `WITH claimed AS (
       UPDATE article_enrichments e
          SET status = 'processing', claimed_at = now(), updated_at = now()
        WHERE (e.article_id, e.requested_model, e.prompt_version, e.taxonomy_version) = (
                SELECT article_id, requested_model, prompt_version, taxonomy_version
                  FROM article_enrichments
                 WHERE requested_model = $1 AND prompt_version = $2 AND taxonomy_version = $3
                   AND (status = 'pending'
                        OR (status = 'processing' AND claimed_at < now() - interval '10 minutes'))
                 ORDER BY article_id
                 LIMIT 1
                 FOR UPDATE SKIP LOCKED)
       RETURNING e.article_id)
     SELECT a.id, a.headline, a.body, a.language, a.content_hash
       FROM claimed c JOIN articles a ON a.id = c.article_id`,
    params(key),
  );
  return result.rows[0] ?? null;
}

/** A claimed row back to `pending`: the budget or the provider stopped the run. */
async function release(db: Queryable, key: RunKey, id: string): Promise<void> {
  await db.query(
    `UPDATE article_enrichments
        SET status = 'pending', claimed_at = NULL, updated_at = now()
      WHERE requested_model = $1 AND prompt_version = $2 AND taxonomy_version = $3
        AND article_id = $4`,
    [...params(key), id],
  );
}

type RowValues = {
  status: "done" | "failed";
  summary?: string;
  sentiment?: string;
  tags?: string[];
  model?: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  costUsd?: number;
  attempts?: number;
  error?: string;
};

async function finish(
  db: Queryable,
  key: RunKey,
  article: Claimed,
  v: RowValues,
): Promise<void> {
  await db.query(
    `UPDATE article_enrichments
        SET status = $5, content_hash = $6, summary = $7, sentiment = $8, tags = $9,
            model = $10, provider = $11, input_tokens = $12, output_tokens = $13,
            latency_ms = $14, cost_usd = $15, attempts = $16, error = $17,
            claimed_at = NULL, updated_at = now()
      WHERE requested_model = $1 AND prompt_version = $2 AND taxonomy_version = $3
        AND article_id = $4`,
    [
      ...params(key),
      article.id,
      v.status,
      article.content_hash,
      v.summary ?? null,
      v.sentiment ?? null,
      v.tags ?? null,
      v.model || null,
      v.provider || null,
      v.inputTokens ?? null,
      v.outputTokens ?? null,
      v.latencyMs ?? null,
      v.costUsd ?? null,
      v.attempts ?? null,
      v.error ?? null,
    ],
  );
}

/**
 * Dedup (spec §3): a `done` row of this run key with the same content hash is
 * copied instead of calling. The copy keeps the result, `model` and `provider`,
 * and stores null for latency, tokens, cost and attempts: no call was made for
 * it, so metrics count each real call once.
 */
async function copyDone(
  db: Queryable,
  key: RunKey,
  article: Claimed,
): Promise<boolean> {
  const found = await db.query<{
    summary: string;
    sentiment: string;
    tags: string[];
    model: string | null;
    provider: string | null;
  }>(
    `SELECT summary, sentiment, tags, model, provider
       FROM article_enrichments
      WHERE content_hash = $4 AND requested_model = $1 AND prompt_version = $2
        AND taxonomy_version = $3 AND status = 'done'
      LIMIT 1`,
    [...params(key), article.content_hash],
  );
  const row = found.rows[0];
  if (!row) return false;
  await finish(db, key, article, {
    status: "done",
    summary: row.summary,
    sentiment: row.sentiment,
    tags: row.tags,
    model: row.model ?? undefined,
    provider: row.provider ?? undefined,
  });
  return true;
}

export async function runWorker(
  db: Queryable,
  provider: EnrichmentProvider,
  budget: Budget,
  key: RunKey,
  opts: { concurrency?: number; timeoutMs?: number } = {},
): Promise<WorkerResult> {
  const result: WorkerResult = {
    done: 0,
    failed: 0,
    copied: 0,
    budgetExceeded: false,
  };
  let stop = false;

  const loop = async (): Promise<void> => {
    while (!stop) {
      const article = await claim(db, key);
      if (!article) return;
      try {
        if (await copyDone(db, key, article)) {
          result.done++;
          result.copied++;
          continue;
        }
        const outcome = await guardedCall(
          provider,
          budget,
          toProviderInput(article),
          { timeoutMs: opts.timeoutMs },
        );
        if (outcome.status === "budget_exceeded") {
          stop = true;
          result.budgetExceeded = true;
          await release(db, key, article.id);
        } else if (outcome.status === "rejected") {
          stop = true;
          result.rejected = outcome.httpStatus;
          await release(db, key, article.id);
        } else if (outcome.status === "done") {
          await finish(db, key, article, { ...outcome, ...outcome.value });
          result.done++;
        } else {
          // Never a default: a failed row has no summary, sentiment or tags.
          await finish(db, key, article, {
            status: "failed",
            error: outcome.error,
            model: outcome.model,
            provider: outcome.provider,
            inputTokens: outcome.inputTokens,
            outputTokens: outcome.outputTokens,
            latencyMs: outcome.latencyMs,
            costUsd: outcome.costUsd,
            attempts: outcome.attempts,
          });
          result.failed++;
          if (outcome.budgetExceeded) {
            stop = true;
            result.budgetExceeded = true;
          }
        }
      } catch (error) {
        stop = true;
        await release(db, key, article.id).catch(() => {});
        throw error;
      }
    }
  };

  const loops = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  const settled = await Promise.allSettled(Array.from({ length: loops }, loop));
  const failure = settled.find((s) => s.status === "rejected");
  if (failure) throw failure.reason;
  return result;
}

type Env = Record<string, string | undefined>;

export function concurrency(env: Env = process.env): number {
  if (!env.ENRICH_CONCURRENCY) return DEFAULT_CONCURRENCY;
  const value = Number(env.ENRICH_CONCURRENCY);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("ENRICH_CONCURRENCY must be a positive integer");
  }
  return value;
}

/**
 * `npm run enrich [-- --force]`. Returns the exit code: 0 done, 2 budget_exceeded
 * (nothing further processed), 1 anything else.
 */
export async function enrichCommand(
  db: Queryable,
  env: Env,
  args: string[],
  opts: { provider?: EnrichmentProvider; log?: (line: string) => void } = {},
): Promise<number> {
  const log = opts.log ?? console.log;
  const key = activeRunKey(env);
  const force = args.includes("--force");
  if (force && llmMode(env) === "live") {
    // A forced live run repeats paid calls beyond the one run per model (spec S10).
    log("enrich: --force is refused in live mode");
    return 1;
  }
  const provider = opts.provider ?? createProvider(env);
  const budget = createBudget(db, dailyTokenBudget(env));
  const label = params(key).join(" / ");

  if (force) await resetRunKey(db, key);
  await enqueue(db, key);
  const result = await runWorker(db, provider, budget, key, {
    concurrency: concurrency(env),
  });
  log(
    `enrich: run key ${label}: done ${result.done} (copied ${result.copied}), failed ${result.failed}`,
  );

  if (result.rejected !== undefined) {
    log(
      `enrich: the provider refused the request (HTTP ${result.rejected}); the run stopped and unprocessed rows stay pending`,
    );
    return 1;
  }
  if (result.budgetExceeded) {
    const pending = await db.query(
      `SELECT 1 FROM article_enrichments
        WHERE requested_model = $1 AND prompt_version = $2 AND taxonomy_version = $3
          AND status = 'pending'`,
      params(key),
    );
    log(
      `enrich: budget_exceeded: the daily token budget is used up; ${pending.rowCount} row(s) left pending. ` +
        "Run `npm run enrich` (without --force) once the budget allows.",
    );
    return 2;
  }
  return 0;
}
