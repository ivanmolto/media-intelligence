// The mock provider (spec S7): deterministic fixtures, no network. It is the
// default, and what `docker compose up` runs. `npm run security-audit` checks that
// this file makes no network call.
//
// A fixture is found by a hash of the exact provider input, so the mock answers
// only for text it has a recorded answer for. Any other input is an error, never
// a made-up or default enrichment.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  ProviderError,
  type EnrichmentProvider,
  type ProviderResult,
} from "./provider";
import type { ProviderInput } from "./prompt";

export const MOCK_FIXTURES_URL = new URL(
  "../../tests/fixtures/mock-enrichments.json",
  import.meta.url,
);

export type MockFixture = {
  external_id: number;
  key: string;
  output: unknown;
  input_tokens: number;
  output_tokens: number;
};

export type MockFixtureFile = {
  /** "hand-written", or "live" with the model and date of the run it replays. */
  provenance: string;
  model?: string;
  run_date?: string;
  note: string;
  fixtures: MockFixture[];
};

export function inputKey(input: ProviderInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify([input.headline ?? null, input.body, input.language]),
      "utf8",
    )
    .digest("hex");
}

export class MockProvider implements EnrichmentProvider {
  private readonly byKey: Map<string, MockFixture>;

  constructor(file?: MockFixtureFile) {
    const data =
      file ??
      (JSON.parse(readFileSync(MOCK_FIXTURES_URL, "utf8")) as MockFixtureFile);
    this.byKey = new Map(data.fixtures.map((f) => [f.key, f]));
  }

  async enrich(input: ProviderInput): Promise<ProviderResult> {
    const fixture = this.byKey.get(inputKey(input));
    if (!fixture) throw new ProviderError(undefined);
    return {
      raw: fixture.output,
      model: "mock",
      provider: "mock",
      inputTokens: fixture.input_tokens,
      outputTokens: fixture.output_tokens,
    };
  }
}
