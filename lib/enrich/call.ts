// The one guarded call (plan §3): reserve budget, call the provider under a
// timeout, validate, correct the reservation; at most one retry. The worker and the
// live adversarial script both go through here, so both run under the same
// guardrails. The input is already capped (toProviderInput).
//
// Retries (spec §3): one on invalid output, on a 5xx or when no response arrived;
// none on a timeout. Each attempt reserves again, so a retry cannot pass the budget.
//
// A 4xx is not a result about the article: the provider refused the request (key,
// credits, rate limit, request shape). It is returned as `rejected` so the caller
// stops the run and leaves the row to be processed later, instead of marking
// every remaining article failed for the same reason.
import type { Budget } from "./budget";
import { ProviderError, type EnrichmentProvider } from "./provider";
import { estimateTokens, type ProviderInput } from "./prompt";
import { validateEnrichment, type Enrichment } from "./schema";

export const TIMEOUT_MS = 20_000;
export const MAX_ATTEMPTS = 2;

export type CallError = "invalid_output" | "timeout" | "provider_error";

/** What the provider calls made for one article add up to. */
export type CallUsage = {
  /** Provider calls made: 0, 1 or 2. */
  attempts: number;
  /** Wall time spent in provider calls, all attempts. */
  latencyMs: number;
  /** From the last response that carried them. */
  model?: string;
  provider?: string;
  /** Summed over the attempts that reported them. */
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  /** The last output received, valid or not. */
  raw?: unknown;
};

export type CallOutcome =
  | ({ status: "done"; value: Enrichment } & CallUsage)
  | ({
      status: "failed";
      error: CallError;
      /** The validator's reason, for invalid output. */
      reason?: string;
      /** True when the retry was not made because the budget could not take it. */
      budgetExceeded: boolean;
    } & CallUsage)
  | { status: "budget_exceeded" }
  | { status: "rejected"; httpStatus: number };

class TimeoutError extends Error {}

const add = (a: number | undefined, b: number | undefined) =>
  b === undefined ? a : (a ?? 0) + b;

export async function guardedCall(
  provider: EnrichmentProvider,
  budget: Budget,
  input: ProviderInput,
  opts: { timeoutMs?: number } = {},
): Promise<CallOutcome> {
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const estimate = estimateTokens(input);
  const usage: CallUsage = { attempts: 0, latencyMs: 0 };
  let error: CallError = "provider_error";
  let reason: string | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const reservation = await budget.reserve(estimate);
    if (!reservation) {
      if (attempt === 1) return { status: "budget_exceeded" };
      return {
        status: "failed",
        error,
        reason,
        budgetExceeded: true,
        ...usage,
      };
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    usage.attempts = attempt;
    try {
      // The race stops the wait even if the provider ignores the signal.
      const result = await Promise.race([
        provider.enrich(input, { signal: controller.signal }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new TimeoutError());
          }, timeoutMs);
        }),
      ]);
      usage.latencyMs += Date.now() - started;
      usage.model = result.model || usage.model;
      usage.provider = result.provider || usage.provider;
      usage.inputTokens = add(usage.inputTokens, result.inputTokens);
      usage.outputTokens = add(usage.outputTokens, result.outputTokens);
      usage.costUsd = add(usage.costUsd, result.costUsd);
      usage.raw = result.raw;
      if (
        result.inputTokens !== undefined &&
        result.outputTokens !== undefined
      ) {
        await budget.correct(
          reservation,
          result.inputTokens + result.outputTokens,
        );
      } // otherwise the estimate stands

      const verdict = validateEnrichment(result.raw);
      if (verdict.ok) return { status: "done", value: verdict.value, ...usage };
      error = "invalid_output";
      reason = verdict.reason;
    } catch (caught) {
      usage.latencyMs += Date.now() - started;
      if (caught instanceof TimeoutError || controller.signal.aborted) {
        // Tokens may have been spent: the estimate stands. No retry.
        return {
          status: "failed",
          error: "timeout",
          budgetExceeded: false,
          ...usage,
        };
      }
      const status =
        caught instanceof ProviderError ? caught.status : undefined;
      if (status !== undefined && status >= 400 && status < 500) {
        await budget.correct(reservation, 0); // refused: nothing was spent
        return { status: "rejected", httpStatus: status };
      }
      error = "provider_error"; // 5xx, or no response: the estimate stands
      reason = undefined;
    } finally {
      clearTimeout(timer);
    }
  }
  return { status: "failed", error, reason, budgetExceeded: false, ...usage };
}
