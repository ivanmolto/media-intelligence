// The provider contract (spec §3), and the one place the environment decides the
// mode and the run key.
import { MockProvider } from "./mock";
import { OpenAICompatibleProvider } from "./openai-compatible";
import { PROMPT_VERSION, type ProviderInput } from "./prompt";
import { TAXONOMY_VERSION } from "./taxonomy";

export type ProviderResult = {
  raw: unknown;
  /** As reported in the response; "" when the response does not say. */
  model: string;
  provider: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
};

export interface EnrichmentProvider {
  enrich(
    input: ProviderInput,
    opts: { signal: AbortSignal },
  ): Promise<ProviderResult>;
}

/**
 * A failed provider call. `status` is the HTTP status, or undefined when no
 * response arrived. The message never carries response text.
 */
export class ProviderError extends Error {
  constructor(readonly status: number | undefined) {
    super(status === undefined ? "no response" : `HTTP ${status}`);
    this.name = "ProviderError";
  }
}

export type RunKey = {
  requestedModel: string;
  promptVersion: string;
  taxonomyVersion: string;
};

type Env = Record<string, string | undefined>;

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

const runKey = (requestedModel: string): RunKey => ({
  requestedModel,
  promptVersion: PROMPT_VERSION,
  taxonomyVersion: TAXONOMY_VERSION,
});

export function llmMode(env: Env = process.env): "mock" | "live" {
  const mode = env.LLM_MODE || "mock";
  if (mode !== "mock" && mode !== "live") {
    throw new Error(`LLM_MODE must be "mock" or "live", not "${mode}"`);
  }
  return mode;
}

/** The run key of the worker, the API and the UI: mock → 'mock', live → ENRICH_MODEL. */
export function activeRunKey(env: Env = process.env): RunKey {
  if (llmMode(env) === "mock") return runKey("mock");
  if (!env.ENRICH_MODEL) {
    throw new Error("LLM_MODE=live needs ENRICH_MODEL");
  }
  return runKey(env.ENRICH_MODEL);
}

/**
 * The run key of the read-only scripts (score, metrics): ENRICH_MODEL if set,
 * otherwise mock. They do not read LLM_MODE and need no key (deviation 8).
 */
export function readOnlyRunKey(env: Env = process.env): RunKey {
  return runKey(env.ENRICH_MODEL || "mock");
}

/** Live mode fails here, at startup, without a key and a model. */
export function createProvider(env: Env = process.env): EnrichmentProvider {
  if (llmMode(env) === "mock") return new MockProvider();
  if (!env.OPENROUTER_API_KEY || !env.ENRICH_MODEL) {
    throw new Error(
      "LLM_MODE=live needs OPENROUTER_API_KEY and ENRICH_MODEL in the environment",
    );
  }
  return new OpenAICompatibleProvider(
    OPENROUTER_BASE_URL,
    env.ENRICH_MODEL,
    env.OPENROUTER_API_KEY,
  );
}
