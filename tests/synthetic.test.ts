import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SENTIMENTS, TAXONOMY } from "@/lib/enrich/taxonomy";
import {
  generateArticle,
  RATES,
  SOURCES,
  syntheticDatabaseUrl,
} from "@/scripts/synthetic";

describe("syntheticDatabaseUrl", () => {
  const url = (name: string) => `postgres://media:media@localhost:5432/${name}`;

  it("accepts the synthetic database", () => {
    expect(
      syntheticDatabaseUrl({ SYNTHETIC_DATABASE_URL: url("media_synthetic") }),
    ).toBe(url("media_synthetic"));
  });

  it("refuses the app database and the test database", () => {
    for (const name of ["media", "media_test", ""]) {
      expect(() =>
        syntheticDatabaseUrl({ SYNTHETIC_DATABASE_URL: url(name) }),
      ).toThrow(/Refusing to run/);
    }
  });

  it("does not fall back to DATABASE_URL", () => {
    expect(() =>
      syntheticDatabaseUrl({ DATABASE_URL: url("media_synthetic") }),
    ).toThrow(/SYNTHETIC_DATABASE_URL is not set/);
  });
});

describe("generateArticle", () => {
  const sample = Array.from({ length: 5000 }, (_, i) => generateArticle(i + 1));

  it("gives the same article for the same number", () => {
    expect(generateArticle(4242)).toEqual(generateArticle(4242));
    expect(generateArticle(1).article.body).not.toBe(
      generateArticle(2).article.body,
    );
  });

  it("uses the number as the id and stays inside the API's value lists", () => {
    for (const [i, { article, sentiment, tags }] of sample.entries()) {
      expect(article.id).toBe(i + 1);
      expect(SOURCES).toContain(article.source);
      expect(["en", "ar", "zh"]).toContain(article.language);
      expect(SENTIMENTS).toContain(sentiment);
      expect(tags.length).toBeGreaterThanOrEqual(1);
      expect(tags.length).toBeLessThanOrEqual(3);
      expect(new Set(tags).size).toBe(tags.length);
      for (const tag of tags) expect(TAXONOMY).toContain(tag);
    }
  });

  it("covers every source, language and sentiment", () => {
    expect(new Set(sample.map((s) => s.article.source)).size).toBe(
      SOURCES.length,
    );
    expect(new Set(sample.map((s) => s.article.language)).size).toBe(3);
    expect(new Set(sample.map((s) => s.sentiment)).size).toBe(
      SENTIMENTS.length,
    );
  });

  it("contains each term of RATES, in English and in non-English articles", () => {
    for (const term of Object.keys(RATES)) {
      const withTerm = sample.filter((s) =>
        (" " + s.article.body + " ").includes(" " + term + " "),
      );
      expect(withTerm.some((s) => s.article.language === "en")).toBe(true);
      expect(withTerm.some((s) => s.article.language !== "en")).toBe(true);
    }
  });

  // Reads the queries, never expected results: a query whose words the generator
  // cannot produce would match nothing and prove nothing about an index.
  it("can produce every word the search cases of the queries file ask for", () => {
    const file = JSON.parse(
      readFileSync(
        new URL("../scripts/explain-queries.json", import.meta.url),
        "utf8",
      ),
    ) as { cases: { params: { q?: string } }[] };
    const produced = Object.keys(RATES).join(" ");
    const asked = file.cases
      .flatMap((c) => (c.params.q ?? "").match(/[a-z]+\*?/g) ?? [])
      .filter((word) => !["and", "or", "not"].includes(word));
    expect(asked.length).toBeGreaterThan(0);
    for (const word of asked) {
      const stem = word.replace(/\*$/, "");
      expect(produced.split(" ").some((term) => term.startsWith(stem))).toBe(
        true,
      );
    }
  });
});
