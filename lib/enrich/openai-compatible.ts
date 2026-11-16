// The live provider: one chat-completions request per article to an
// OpenAI-compatible endpoint (OpenRouter). The model gets the two messages and the
// output schema and nothing else: no callable capabilities are declared, and
// nothing it returns is fetched or followed.
//
// Model, provider, tokens and cost are read from the response (spec S9). Every one
// of them is optional here: a field the response does not carry is stored as null,
// never computed from the request.
import {
  ProviderError,
  type EnrichmentProvider,
  type ProviderResult,
} from "./provider";
import { buildMessages, OUTPUT_CAP_TOKENS, type ProviderInput } from "./prompt";
import { RESPONSE_JSON_SCHEMA } from "./schema";

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const str = (value: unknown): string =>
  typeof value === "string" ? value : "";

export class OpenAICompatibleProvider implements EnrichmentProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly apiKey: string,
  ) {}

  requestBody(input: ProviderInput): Record<string, unknown> {
    const { system, user } = buildMessages(input);
    return {
      model: this.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "enrichment",
          strict: true,
          schema: RESPONSE_JSON_SCHEMA,
        },
      },
      max_tokens: OUTPUT_CAP_TOKENS,
      // OpenRouter: report cost in `usage`, and route only to an upstream that
      // honours every parameter above, response_format included.
      usage: { include: true },
      provider: { require_parameters: true },
    };
  }

  async enrich(
    input: ProviderInput,
    opts: { signal: AbortSignal },
  ): Promise<ProviderResult> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(this.requestBody(input)),
        signal: opts.signal,
      });
    } catch (error) {
      if (opts.signal.aborted) throw error; // the caller's timeout
      throw new ProviderError(undefined);
    }
    if (!response.ok) throw new ProviderError(response.status);

    let data: Record<string, unknown>;
    try {
      data = (await response.json()) as Record<string, unknown>;
    } catch (error) {
      if (opts.signal.aborted) throw error;
      throw new ProviderError(undefined);
    }
    // OpenRouter can answer 200 with an error object in the body.
    const failure = data.error as { code?: unknown } | undefined;
    if (failure) throw new ProviderError(num(failure.code) ?? 502);

    const usage = (data.usage ?? {}) as Record<string, unknown>;
    const choices = data.choices as
      { message?: { content?: unknown } }[] | undefined;
    return {
      raw: choices?.[0]?.message?.content ?? null,
      model: str(data.model),
      provider: str(data.provider),
      inputTokens: num(usage.prompt_tokens),
      outputTokens: num(usage.completion_tokens),
      costUsd: num(usage.cost),
    };
  }
}
