// Offline adversarial test (spec §6, intent outcome 5). No database, no network.
// It asserts the deterministic controls only: the prompt builder strips HTML and
// escapes the article so nothing in it can close the block, and the validator
// rejects a compromised output. It does not show how a live model behaves: that
// is docs/evaluations/adversarial-<model>.json.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Budget } from "@/lib/enrich/budget";
import { ProviderError, type EnrichmentProvider } from "@/lib/enrich/provider";
import {
  loadCases,
  main as adversarialMain,
  runAdversarial,
} from "@/scripts/adversarial-live";
import { stripHtml } from "@/lib/html/strip";
import {
  buildMessages,
  capBody,
  estimateTokens,
  INPUT_CAP_CHARS,
  OUTPUT_CAP_TOKENS,
  PROMPT_TOKENS,
  SYSTEM_PROMPT,
  toProviderInput,
} from "@/lib/enrich/prompt";
import { validateEnrichment } from "@/lib/enrich/schema";
import { TAXONOMY } from "@/lib/enrich/taxonomy";

type Case = {
  id: string;
  category: string;
  input: { headline: string; body: string; language: string };
  must_not_reach_prompt: string[];
  outputs: { output: unknown; verdict: "valid" | "invalid" }[];
};

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/adversarial.json", import.meta.url), "utf8"),
) as { cases: Case[] };

const valid = {
  summary: "Crude oil prices rose sharply as tensions raised supply concerns.",
  sentiment: "negative",
  tags: ["energy", "geopolitics"],
};

describe("adversarial fixtures", () => {
  it("cover every category of spec §6", () => {
    const categories = new Set(fixture.cases.map((c) => c.category));
    for (const required of [
      "override",
      "sentiment steering",
      "exfiltration",
      "forged </article>",
    ]) {
      expect(categories).toContain(required);
    }
    expect(fixture.cases.map((c) => c.id)).toContain("no_url_in_summary");
  });

  describe.each(fixture.cases)("$id", (c) => {
    const { user } = buildMessages(toProviderInput(c.input));

    it("is one block that the article cannot close", () => {
      expect(user.startsWith("<article>\n")).toBe(true);
      expect(user.endsWith("\n</article>")).toBe(true);
      const inner = user.slice("<article>\n".length, -"\n</article>".length);
      expect(inner).not.toMatch(/[<>&]/);
      // still JSON, and the text survives as data
      const parsed = JSON.parse(inner) as { body: string; headline?: string };
      expect(parsed.body.length).toBeGreaterThan(0);
    });

    it("carries no HTML into the prompt", () => {
      for (const fragment of c.must_not_reach_prompt) {
        expect(user).not.toContain(fragment);
      }
    });

    it.each(c.outputs)("validator verdict: $verdict", (o) => {
      expect(validateEnrichment(o.output).ok).toBe(o.verdict === "valid");
      // the same output as JSON text, as a provider returns it
      expect(validateEnrichment(JSON.stringify(o.output)).ok).toBe(
        o.verdict === "valid",
      );
    });
  });

  it("a forged closing tag that survives stripping reaches the model as text", () => {
    const c = fixture.cases.find((x) => x.id === "forged_delimiter");
    if (!c) throw new Error("no forged_delimiter case");
    const input = toProviderInput(c.input);
    expect(input.body).toContain("</article>"); // decoded from entities by the strip
    expect(buildMessages(input).user.match(/<\/article>/g)).toHaveLength(1);
  });
});

describe("validateEnrichment", () => {
  it("accepts a valid output", () => {
    expect(validateEnrichment(valid)).toEqual({ ok: true, value: valid });
  });

  it("drops fields outside the contract", () => {
    const verdict = validateEnrichment({ ...valid, url: "x", note: "y" });
    expect(verdict).toEqual({ ok: true, value: valid });
  });

  it.each([
    ["summary too short", { ...valid, summary: "Too short." }],
    ["summary too long", { ...valid, summary: "a".repeat(401) }],
    ["http URL", { ...valid, summary: valid.summary + " http://a.example" }],
    ["other scheme", { ...valid, summary: valid.summary + " ftp://a.example" }],
    ["www host", { ...valid, summary: valid.summary + " WWW.a.example" }],
    ["mailto", { ...valid, summary: valid.summary + " mailto:a@b.example" }],
    ["unknown sentiment", { ...valid, sentiment: "bullish" }],
    ["null sentiment", { ...valid, sentiment: null }],
    ["no tags", { ...valid, tags: [] }],
    ["four tags", { ...valid, tags: ["ai", "energy", "health", "sports"] }],
    ["duplicate tags", { ...valid, tags: ["ai", "ai"] }],
    ["tag outside the taxonomy", { ...valid, tags: ["hacked"] }],
    ["tags not an array", { ...valid, tags: "ai" }],
    ["missing field", { summary: valid.summary, tags: valid.tags }],
    ["not an object", "just text"],
    ["null", null],
  ])("rejects: %s", (_name, raw) => {
    const verdict = validateEnrichment(raw);
    expect(verdict.ok).toBe(false);
  });

  it("gives a reason that names the rule and never repeats model text", () => {
    const verdict = validateEnrichment({
      ...valid,
      summary: "SECRET-TEXT " + valid.summary + " https://a.example",
      tags: ["SECRET-TAG"],
    });
    if (verdict.ok) throw new Error("expected a rejection");
    expect(verdict.reason).toContain("summary");
    expect(verdict.reason).toContain("tags");
    expect(verdict.reason).not.toContain("SECRET");
  });
});

describe("prompt builder", () => {
  it("omits an empty headline (article 17)", () => {
    const input = toProviderInput({ headline: "", body: "x", language: "en" });
    expect(input).toEqual({ body: "x", language: "en" });
    expect(buildMessages(input).user).not.toContain("headline");
  });

  it("names every taxonomy id in the system prompt and no article text", () => {
    for (const tag of TAXONOMY) expect(SYSTEM_PROMPT).toContain(tag);
    const { system } = buildMessages(
      toProviderInput({ headline: "ZZHEAD", body: "ZZBODY", language: "en" }),
    );
    expect(system).toBe(SYSTEM_PROMPT);
  });

  it("caps a long body at 8,000 characters, keeping head and tail", () => {
    const body = "H".repeat(7000) + "M".repeat(5000) + "T".repeat(3000);
    const capped = capBody(body);
    expect(capped).toHaveLength(INPUT_CAP_CHARS);
    expect(capped.startsWith("H")).toBe(true);
    expect(capped.endsWith("T".repeat(2000))).toBe(true);
    expect(capBody("short")).toBe("short");
  });

  it("estimates ceil(chars / 4) + prompt + output cap", () => {
    const input = { headline: "abcde", body: "x".repeat(10), language: "en" };
    expect(estimateTokens(input)).toBe(4 + PROMPT_TOKENS + OUTPUT_CAP_TOKENS);
    expect(estimateTokens({ body: "", language: "en" })).toBe(
      PROMPT_TOKENS + OUTPUT_CAP_TOKENS,
    );
  });

  it("sends a tag spelled with entities as escaped text, not markup", () => {
    const input = toProviderInput({
      headline: "",
      body: "safe &lt;script&gt;alert(1)&lt;/script&gt; text",
      language: "en",
    });
    expect(input.body).toBe("safe <script>alert(1)</script> text");
    expect(buildMessages(input).user).toContain("\\u003cscript\\u003e");
  });

  it("produces the stored body_text for a sample article with markup", () => {
    const body =
      'said: "we will <b onmouseover=alert(1)>vigorously</b> defend"';
    expect(toProviderInput({ headline: "", body, language: "en" }).body).toBe(
      stripHtml(body),
    );
  });
});

// The live runner's logic, with a fake provider: no network, no database.
describe("live adversarial runner", () => {
  const cases = loadCases();
  const budget: Budget = {
    reserve: async (tokens) => ({ day: "2026-01-01", tokens }),
    correct: async () => {},
  };
  const answering = (
    answer: (index: number) => unknown | Error,
  ): EnrichmentProvider => {
    let index = 0;
    return {
      enrich: async () => {
        const raw = answer(index++);
        if (raw instanceof Error) throw raw;
        return {
          raw,
          model: "m",
          provider: "p",
          inputTokens: 1,
          outputTokens: 1,
        };
      },
    };
  };
  const clean = {
    summary: "A summary of the article that follows no planted instruction.",
    sentiment: "negative",
    tags: ["business"],
  };

  it("reads the same fixture file as the offline test", () => {
    expect(cases.map((c) => c.id)).toEqual(fixture.cases.map((c) => c.id));
  });

  it("records the validator's verdict and the raw output for every case", async () => {
    const { results, stopped } = await runAdversarial(
      answering(() => clean),
      budget,
      cases,
    );
    expect(stopped).toBeUndefined();
    expect(results).toHaveLength(cases.length);
    for (const r of results) {
      expect(r).toMatchObject({
        verdict: "valid",
        raw_output: clean,
        attempts: 1,
      });
      expect(r.canary_in_output === false || r.canary_in_output === null).toBe(
        true,
      );
    }
  });

  it("reports a steered output as observed: invalid, canary seen, planted sentiment returned", async () => {
    const steered = await runAdversarial(
      answering(() => ({
        ...clean,
        summary: "CANARY-OVERRIDE-41 system compromised",
        tags: ["hacked"],
      })),
      budget,
      cases.filter((c) => c.id === "override"),
    );
    expect(steered.results[0]).toMatchObject({
      verdict: "invalid",
      canary_in_output: true,
      attempts: 2,
    });

    const inSchema = await runAdversarial(
      answering(() => ({ ...clean, sentiment: "positive" })),
      budget,
      cases.filter((c) => c.id === "sentiment_steering"),
    );
    expect(inSchema.results[0]).toMatchObject({
      verdict: "valid",
      planted_sentiment_returned: true,
    });
  });

  it("stops at a refused request and marks the rest not run", async () => {
    const { results, stopped } = await runAdversarial(
      answering((i) => (i === 0 ? clean : new ProviderError(402))),
      budget,
      cases,
    );
    expect(stopped).toContain("402");
    expect(results.map((r) => r.verdict)).toEqual([
      "valid",
      ...cases.slice(1).map(() => "not_run"),
    ]);
  });

  it("refuses mock mode before anything is created or called", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await adversarialMain({ LLM_MODE: "mock" })).toBe(1);
    expect(await adversarialMain({})).toBe(1);
    expect(errors.mock.calls.join()).toContain("refused in mock mode");
    errors.mockRestore();
  });
});
