// The output contract (spec §3). Model output is untrusted: nothing is stored
// unless it passes `validateEnrichment`, and nothing is defaulted when it fails.
import { z } from "zod";
import { SENTIMENTS, TAXONOMY } from "./taxonomy";

// A URL is a scheme followed by "://", a "www." host, or a mailto: address. A bare
// domain ("evil.example") is not matched: it cannot be told from ordinary text
// ("U.S.", "3.5%"). Summaries are rendered as text and never linked or fetched.
const URL_LIKE = /[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\bmailto:/i;

export const enrichmentSchema = z.object({
  summary: z
    .string()
    .min(20)
    .max(400)
    .refine((text) => !URL_LIKE.test(text), { message: "contains a URL" }),
  sentiment: z.enum(SENTIMENTS),
  tags: z
    .array(z.enum(TAXONOMY))
    .min(1)
    .max(3)
    .refine((tags) => new Set(tags).size === tags.length, {
      message: "duplicate tag",
    }),
});

export type Enrichment = z.infer<typeof enrichmentSchema>;

export type Verdict =
  { ok: true; value: Enrichment } | { ok: false; reason: string };

/**
 * Validates what a provider returned: an object, or the JSON text of one. The
 * reason names the field and the rule only; it never repeats model text.
 */
export function validateEnrichment(raw: unknown): Verdict {
  let candidate = raw;
  if (typeof raw === "string") {
    try {
      candidate = JSON.parse(raw);
    } catch {
      return { ok: false, reason: "not JSON" };
    }
  }
  const parsed = enrichmentSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, value: parsed.data };
  const reason = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`)
    .join("; ");
  return { ok: false, reason };
}

/**
 * The schema sent to the provider as `response_format`. Types and enums only:
 * providers differ on which length and uniqueness keywords they accept, so those
 * rules are enforced here, by Zod, and not assumed of the provider.
 */
export const RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    sentiment: { type: "string", enum: [...SENTIMENTS] },
    tags: { type: "array", items: { type: "string", enum: [...TAXONOMY] } },
  },
  required: ["summary", "sentiment", "tags"],
  additionalProperties: false,
} as const;
