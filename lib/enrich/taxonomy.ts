// Taxonomy v1 (spec §3). The version is part of the run key: changing the list
// means a new version and new rows, never rewritten ones.
export const TAXONOMY_VERSION = "v1";

export const TAXONOMY = [
  "geopolitics",
  "economy",
  "markets",
  "business",
  "technology",
  "ai",
  "cybersecurity",
  "regulation",
  "energy",
  "climate",
  "health",
  "transport",
  "sports",
  "other",
] as const;

export const SENTIMENTS = ["positive", "negative", "neutral", "mixed"] as const;

export type Tag = (typeof TAXONOMY)[number];
export type Sentiment = (typeof SENTIMENTS)[number];
