// Guardrails that need no database (spec §3, §6 "Cost runaway"): the guarded
// call's budget reservation, timeout and retry policy against a fake provider and
// an in-memory budget; the live provider's request body; the mock's isolation.
// The SQL side (atomic reservation, dedup, claim) is guardrails.integration.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dailyTokenBudget,
  DEFAULT_DAILY_TOKEN_BUDGET,
  type Budget,
  type Reservation,
} from "@/lib/enrich/budget";
import { guardedCall, MAX_ATTEMPTS, TIMEOUT_MS } from "@/lib/enrich/call";
import { MockProvider } from "@/lib/enrich/mock";
import { OpenAICompatibleProvider } from "@/lib/enrich/openai-compatible";
import {
  activeRunKey,
  createProvider,
  llmMode,
  ProviderError,
  readOnlyRunKey,
  type EnrichmentProvider,
  type ProviderResult,
} from "@/lib/enrich/provider";
import {
  estimateTokens,
  OUTPUT_CAP_TOKENS,
  toProviderInput,
} from "@/lib/enrich/prompt";
import { loadSampleArticles } from "@/scripts/seed";

const input = toProviderInput({
  headline: "Headline",
  body: "Body text of the article.",
  language: "en",
});
const estimate = estimateTokens(input);

const good = {
  summary: "A valid summary that is long enough to pass the schema.",
  sentiment: "neutral",
  tags: ["economy"],
};
const response = (raw: unknown, tokens = [100, 20]): ProviderResult => ({
  raw,
  model: "vendor/model-as-returned",
  provider: "UpstreamCo",
  inputTokens: tokens[0],
  outputTokens: tokens[1],
  costUsd: 0.001,
});

type Step = ProviderResult | Error | "hang";

/** A provider that plays a script, one step per call. */
function fakeProvider(steps: Step[]) {
  const signals: AbortSignal[] = [];
  const provider: EnrichmentProvider = {
    enrich(_input, { signal }) {
      signals.push(signal);
      const step = steps[signals.length - 1];
      if (step === undefined) throw new Error("unexpected provider call");
      if (step === "hang") return new Promise(() => {}); // ignores the signal
      return step instanceof Error
        ? Promise.reject(step)
        : Promise.resolve(step);
    },
  };
  return { provider, signals, calls: () => signals.length };
}

/** An in-memory budget with the same rule as the SQL one. */
function fakeBudget(limit: number) {
  const state = { used: 0, reservations: [] as number[] };
  const budget: Budget = {
    async reserve(tokens) {
      if (state.used + tokens > limit) return null;
      state.used += tokens;
      state.reservations.push(tokens);
      return { day: "2026-01-01", tokens };
    },
    async correct(reservation: Reservation, actual) {
      state.used += actual - reservation.tokens;
    },
  };
  return { budget, state };
}

describe("guardedCall", () => {
  it("reserves the estimate, then corrects it to the reported tokens", async () => {
    const { provider, calls } = fakeProvider([response(good)]);
    const { budget, state } = fakeBudget(10_000);
    const outcome = await guardedCall(provider, budget, input);
    expect(outcome).toMatchObject({
      status: "done",
      value: good,
      attempts: 1,
      model: "vendor/model-as-returned",
      provider: "UpstreamCo",
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.001,
    });
    expect(calls()).toBe(1);
    expect(state.reservations).toEqual([estimate]);
    expect(state.used).toBe(120);
  });

  it("keeps the estimate when the provider reports no tokens", async () => {
    const { provider } = fakeProvider([{ raw: good, model: "", provider: "" }]);
    const { budget, state } = fakeBudget(10_000);
    const outcome = await guardedCall(provider, budget, input);
    expect(outcome).toMatchObject({ status: "done", attempts: 1 });
    expect(outcome).not.toHaveProperty("costUsd", expect.anything());
    expect(state.used).toBe(estimate);
  });

  it("stops before calling when the budget cannot take the estimate", async () => {
    const { provider, calls } = fakeProvider([]);
    const { budget, state } = fakeBudget(estimate - 1);
    expect(await guardedCall(provider, budget, input)).toEqual({
      status: "budget_exceeded",
    });
    expect(calls()).toBe(0);
    expect(state.used).toBe(0);
  });

  it("retries once on invalid output; the second attempt reserves again", async () => {
    const { provider, calls } = fakeProvider([
      response({ ...good, sentiment: "bullish" }),
      response(good, [110, 25]),
    ]);
    const { budget, state } = fakeBudget(10_000);
    const outcome = await guardedCall(provider, budget, input);
    expect(outcome).toMatchObject({
      status: "done",
      attempts: 2,
      inputTokens: 210,
      outputTokens: 45,
      costUsd: 0.002,
    });
    expect(calls()).toBe(2);
    expect(state.reservations).toEqual([estimate, estimate]);
    expect(state.used).toBe(255);
  });

  it("fails after the retry and never defaults a value", async () => {
    const bad = { ...good, tags: ["hacked"] };
    const { provider, calls } = fakeProvider([response(bad), response(bad)]);
    const outcome = await guardedCall(
      provider,
      fakeBudget(10_000).budget,
      input,
    );
    expect(outcome).toMatchObject({
      status: "failed",
      error: "invalid_output",
      attempts: 2,
      budgetExceeded: false,
    });
    expect(outcome).not.toHaveProperty("value");
    expect(calls()).toBe(MAX_ATTEMPTS);
  });

  it("does not retry past the budget: the row fails and the run is told to stop", async () => {
    const { provider, calls } = fakeProvider([
      response({ ...good, summary: "short" }, [estimate, 0]),
    ]);
    // room for one reservation only, even after the correction
    const { budget } = fakeBudget(estimate * 2 - 1);
    const outcome = await guardedCall(provider, budget, input);
    expect(outcome).toMatchObject({
      status: "failed",
      error: "invalid_output",
      attempts: 1,
      budgetExceeded: true,
    });
    expect(calls()).toBe(1);
  });

  it.each([
    ["a 5xx", new ProviderError(503)],
    ["no response", new ProviderError(undefined)],
    ["an unknown error", new Error("boom")],
  ])("retries once on %s", async (_name, error) => {
    const recovered = fakeProvider([error, response(good)]);
    expect(
      await guardedCall(recovered.provider, fakeBudget(10_000).budget, input),
    ).toMatchObject({ status: "done", attempts: 2 });

    const down = fakeProvider([error, error]);
    expect(
      await guardedCall(down.provider, fakeBudget(10_000).budget, input),
    ).toMatchObject({ status: "failed", error: "provider_error", attempts: 2 });
    expect(down.calls()).toBe(2);
  });

  it.each([400, 401, 402, 429])(
    "does not retry a %i: the request is rejected and nothing is charged",
    async (status) => {
      const { provider, calls } = fakeProvider([new ProviderError(status)]);
      const { budget, state } = fakeBudget(10_000);
      expect(await guardedCall(provider, budget, input)).toEqual({
        status: "rejected",
        httpStatus: status,
      });
      expect(calls()).toBe(1);
      expect(state.used).toBe(0);
    },
  );

  it("times out, aborts the signal and does not retry", async () => {
    const { provider, signals, calls } = fakeProvider(["hang"]);
    const { budget, state } = fakeBudget(10_000);
    const outcome = await guardedCall(provider, budget, input, {
      timeoutMs: 20,
    });
    expect(outcome).toMatchObject({
      status: "failed",
      error: "timeout",
      attempts: 1,
    });
    expect(signals[0]?.aborted).toBe(true);
    expect(calls()).toBe(1);
    expect(state.used).toBe(estimate); // tokens may have been spent
  });

  it("uses a 20 s timeout and one retry by default", () => {
    expect(TIMEOUT_MS).toBe(20_000);
    expect(MAX_ATTEMPTS).toBe(2);
  });
});

describe("OpenAICompatibleProvider", () => {
  afterEach(() => vi.unstubAllGlobals());

  const provider = new OpenAICompatibleProvider(
    "https://llm.example/api/v1",
    "vendor/requested-model",
    "test-key",
  );
  const signal = new AbortController().signal;
  const reply = (body: unknown, status = 200) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status }));

  it("sends the capped output, the schema and nothing callable", async () => {
    const fetchMock = reply({ choices: [{ message: { content: "{}" } }] });
    vi.stubGlobal("fetch", fetchMock);
    await provider.enrich(input, { signal });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://llm.example/api/v1/chat/completions");
    expect(init.signal).toBe(signal);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.model).toBe("vendor/requested-model");
    expect(body.max_tokens).toBe(OUTPUT_CAP_TOKENS);
    expect(body.response_format).toMatchObject({ type: "json_schema" });
    expect(body.messages).toHaveLength(2);
    for (const key of ["tools", "tool_choice", "functions", "function_call"]) {
      expect(body).not.toHaveProperty(key);
    }
    expect(init.body as string).not.toContain("test-key");
  });

  it("reads model, provider, tokens and cost from the response", async () => {
    vi.stubGlobal(
      "fetch",
      reply({
        model: "vendor/model-as-returned",
        provider: "UpstreamCo",
        choices: [{ message: { content: JSON.stringify(good) } }],
        usage: { prompt_tokens: 321, completion_tokens: 54, cost: 0.000123 },
      }),
    );
    expect(await provider.enrich(input, { signal })).toEqual({
      raw: JSON.stringify(good),
      model: "vendor/model-as-returned", // not the requested id
      provider: "UpstreamCo",
      inputTokens: 321,
      outputTokens: 54,
      costUsd: 0.000123,
    });
  });

  it("leaves what the response does not report undefined", async () => {
    vi.stubGlobal("fetch", reply({ choices: [] }));
    expect(await provider.enrich(input, { signal })).toEqual({
      raw: null,
      model: "",
      provider: "",
      inputTokens: undefined,
      outputTokens: undefined,
      costUsd: undefined,
    });
  });

  it("turns an HTTP error into a status, without the response text", async () => {
    vi.stubGlobal("fetch", reply({ error: { message: "SECRET detail" } }, 429));
    const error = await provider.enrich(input, { signal }).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).status).toBe(429);
    expect(String(error)).not.toContain("SECRET");
  });

  it("treats a 200 with an error body and a network failure as provider errors", async () => {
    vi.stubGlobal("fetch", reply({ error: { code: 502, message: "x" } }));
    expect(
      (
        (await provider
          .enrich(input, { signal })
          .catch((e) => e)) as ProviderError
      ).status,
    ).toBe(502);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const error = await provider.enrich(input, { signal }).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).status).toBeUndefined();
  });
});

describe("MockProvider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("answers every sample article without a network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const mock = new MockProvider();
    for (const article of loadSampleArticles()) {
      const result = await mock.enrich(toProviderInput(article));
      expect(result).toMatchObject({ model: "mock", provider: "mock" });
      expect(result.inputTokens).toBeGreaterThan(0);
      expect(result.outputTokens).toBeGreaterThan(0);
      expect(result.costUsd).toBeUndefined();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("has no answer for text it has no fixture for", async () => {
    const error = await new MockProvider().enrich(input).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
  });
});

describe("environment", () => {
  it("defaults to mock and needs no key", () => {
    expect(llmMode({})).toBe("mock");
    expect(createProvider({})).toBeInstanceOf(MockProvider);
    expect(activeRunKey({ ENRICH_MODEL: "vendor/m" })).toMatchObject({
      requestedModel: "mock",
      promptVersion: "v1",
      taxonomyVersion: "v1",
    });
  });

  it("refuses live mode without a key and a model", () => {
    expect(() => createProvider({ LLM_MODE: "live" })).toThrow(/needs/);
    expect(() =>
      createProvider({ LLM_MODE: "live", ENRICH_MODEL: "vendor/m" }),
    ).toThrow(/needs/);
    expect(() =>
      createProvider({ LLM_MODE: "live", OPENROUTER_API_KEY: "k" }),
    ).toThrow(/needs/);
    expect(() => activeRunKey({ LLM_MODE: "live" })).toThrow(/ENRICH_MODEL/);
    expect(() => llmMode({ LLM_MODE: "Live" })).toThrow(/LLM_MODE/);
  });

  it("uses the requested model as the live run key", () => {
    const env = {
      LLM_MODE: "live",
      ENRICH_MODEL: "vendor/m",
      OPENROUTER_API_KEY: "k",
    };
    expect(createProvider(env)).toBeInstanceOf(OpenAICompatibleProvider);
    expect(activeRunKey(env).requestedModel).toBe("vendor/m");
  });

  it("gives the read-only scripts ENRICH_MODEL if set, otherwise mock", () => {
    expect(readOnlyRunKey({ LLM_MODE: "live" }).requestedModel).toBe("mock");
    expect(
      readOnlyRunKey({ LLM_MODE: "mock", ENRICH_MODEL: "vendor/m" })
        .requestedModel,
    ).toBe("vendor/m");
  });

  it("reads the daily budget, with a default", () => {
    expect(dailyTokenBudget({})).toBe(DEFAULT_DAILY_TOKEN_BUDGET);
    expect(dailyTokenBudget({ DAILY_TOKEN_BUDGET: "1000" })).toBe(1000);
    expect(() => dailyTokenBudget({ DAILY_TOKEN_BUDGET: "lots" })).toThrow();
    expect(() => dailyTokenBudget({ DAILY_TOKEN_BUDGET: "-1" })).toThrow();
  });
});
