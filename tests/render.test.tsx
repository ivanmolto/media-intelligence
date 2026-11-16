// Articles 6 and 18 render as text, article 17 as (Untitled) (spec §6, XSS; intent
// outcome 4). The card is rendered to markup and the markup is read as a string:
// escaped text is there, and no element or attribute came from article text.
//
// The API returns the headline and the enrichment, not the body, so a body reaches
// the page only if a model repeats it. The worst case is tested: each article's own
// body, markup included, as its summary.
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ArticleCard } from "@/components/ArticleCard";
import type { ArticleItem } from "@/lib/articles/list";

type Sample = {
  id: number;
  headline: string;
  body: string;
  source: string;
  published_at: string;
  language: string;
};
const samples = JSON.parse(
  readFileSync(
    new URL("../docs/sample_articles.json", import.meta.url),
    "utf8",
  ),
) as Sample[];

function item(id: number, tags: string[] = ["other"]): ArticleItem {
  const a = samples.find((s) => s.id === id)!;
  return {
    id: a.id,
    headline: a.headline,
    source: a.source,
    language: a.language,
    published_at: a.published_at,
    enrichment: { status: "done", summary: a.body, sentiment: "neutral", tags },
  };
}
const render = (value: ArticleItem) =>
  renderToStaticMarkup(<ArticleCard item={value} />);

/** Every tag name in the markup. */
const elements = (html: string) =>
  [...html.matchAll(/<([a-zA-Z][\w-]*)/g)].map((m) => m[1]!.toLowerCase());
const CARD_ELEMENTS = ["article", "h2", "p", "div", "span"];

describe.each([6, 18])("article %i", (id) => {
  const sample = samples.find((s) => s.id === id)!;
  const html = render(item(id));

  it("carries markup in its text, so the test has something to prove", () => {
    expect(sample.headline + sample.body).toMatch(/<[a-z]/i);
  });

  it("renders only the card's own elements", () => {
    expect(new Set(elements(html))).toEqual(new Set(CARD_ELEMENTS));
    expect(html).not.toMatch(/<script|<img|<iframe|<svg|<a[\s>]/i);
  });

  it("adds no attribute from article text", () => {
    // the card sets `class` and nothing else
    const attributes = [...html.matchAll(/<[a-zA-Z][^>]*>/g)].flatMap((m) =>
      [...m[0].matchAll(/\s([a-zA-Z-]+)=/g)].map((a) => a[1]),
    );
    expect(new Set(attributes)).toEqual(new Set(["class"]));
  });

  it("shows the markup as escaped text", () => {
    expect(html).toMatch(/&lt;[a-z]/i);
  });
});

it("article 6: the headline's <img onerror> is text", () => {
  const html = render(item(6));
  expect(html).toContain("&lt;img src=x onerror=alert(&#x27;XSS&#x27;)&gt;");
});

it("a tag or sentiment that is markup is text too", () => {
  const hostile = item(1, ["<script>alert(1)</script>"]);
  hostile.enrichment!.sentiment = "<img src=x onerror=alert(1)>";
  const html = render(hostile);
  expect(new Set(elements(html))).toEqual(new Set(CARD_ELEMENTS));
  expect(html).toContain("&lt;script&gt;");
});

describe("article 17", () => {
  it("has an empty headline in the sample", () => {
    expect(samples.find((s) => s.id === 17)!.headline).toBe("");
  });
  it("shows (Untitled)", () => {
    expect(render(item(17))).toContain("(Untitled)");
  });
});

describe("enrichment states", () => {
  const base = item(1);
  it("no enrichment row: says so, shows no badge", () => {
    const html = render({ ...base, enrichment: undefined });
    expect(html).toContain("Not enriched yet");
    expect(html).not.toMatch(/neutral|positive|negative|mixed/);
  });
  it("failed: says so, never a default sentiment", () => {
    const html = render({
      ...base,
      enrichment: {
        status: "failed",
        summary: null,
        sentiment: null,
        tags: null,
      },
    });
    expect(html).toContain("Enrichment failed");
    expect(html).not.toMatch(/neutral|positive|negative|mixed/);
  });
});
