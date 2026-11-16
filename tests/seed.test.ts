// Unit tests: the article → row mapping. No database (the idempotency proof is in
// seed.integration.test.ts).
import { describe, expect, it } from "vitest";
import { stripHtml } from "@/lib/html/strip";
import {
  contentHash,
  loadSampleArticles,
  parseArticles,
  toRow,
} from "@/scripts/seed";

const articles = loadSampleArticles();
const byId = (id: number) => {
  const found = articles.find((a) => a.id === id);
  if (!found) throw new Error(`no article ${id}`);
  return found;
};

describe("stripHtml", () => {
  it("removes tags and keeps the text between them", () => {
    expect(
      stripHtml("we will <b onmouseover=alert(1)>vigorously</b> defend"),
    ).toBe("we will vigorously defend");
  });

  it("drops the contents of script and style elements", () => {
    expect(
      stripHtml("a <script>document.location='http://evil.com/'</script> b"),
    ).toBe("a b");
    expect(stripHtml("a <STYLE type=x>p { color: red }</STYLE> b")).toBe("a b");
  });

  it("leaves a bare ampersand and a bare angle bracket alone", () => {
    expect(stripHtml("the S&P 500 gained; 3 < 5 and 5 > 3")).toBe(
      "the S&P 500 gained; 3 < 5 and 5 > 3",
    );
  });

  it("decodes basic entities after removing tags, so they stay text", () => {
    expect(
      stripHtml("&lt;b&gt;R&amp;D&lt;/b&gt; &quot;x&quot; &#39;y&#39;"),
    ).toBe("<b>R&D</b> \"x\" 'y'");
  });

  it("collapses whitespace and trims", () => {
    expect(stripHtml("  a\n\n<p>b</p>\t c  ")).toBe("a b c");
  });
});

describe("parseArticles", () => {
  it("accepts the sample file: 20 articles", () => {
    expect(articles).toHaveLength(20);
  });

  it("rejects a record with a missing or mistyped field", () => {
    expect(() => parseArticles([{ ...byId(1), body: undefined }])).toThrow(
      /body/,
    );
    expect(() => parseArticles([{ ...byId(1), id: "1" }])).toThrow(/id/);
    expect(() => parseArticles({})).toThrow(/array/);
  });

  it("rejects a published_at that is not a date", () => {
    expect(() =>
      parseArticles([{ ...byId(1), published_at: "yesterday" }]),
    ).toThrow(/published_at/);
  });
});

describe("toRow", () => {
  it("article 17: the empty headline is kept as ''", () => {
    expect(toRow(byId(17)).headline).toBe("");
    expect(toRow(byId(17)).headlineText).toBe("");
  });

  it("article 6: body keeps the script, body_text does not", () => {
    const row = toRow(byId(6));
    expect(row.body).toContain("<script>");
    expect(row.bodyText).not.toContain("<script>");
    expect(row.bodyText).not.toContain("evil.com");
    expect(row.bodyText).toContain("exploited a known vulnerability");
    // The headline is stored raw: the source is evidence. Search and the hash
    // use the stripped one.
    expect(row.headline).toContain("<img src=x");
    expect(row.headlineText).toBe("Breaking: Major Data Breach Reported");
    expect(
      row.contentHash.equals(contentHash(row.headlineText, row.bodyText)),
    ).toBe(true);
  });

  it("article 18: the inline tag is removed, its text is kept", () => {
    const row = toRow(byId(18));
    expect(row.bodyText).not.toContain("onmouseover");
    expect(row.bodyText).toContain("we will vigorously defend");
  });

  it("articles 8 and 9: non-Latin text passes through unchanged", () => {
    expect(toRow(byId(8)).bodyText).toBe(byId(8).body);
    expect(toRow(byId(9)).bodyText).toBe(byId(9).body);
  });
});

describe("contentHash", () => {
  it("is 32 bytes and stable", () => {
    const a = contentHash("Headline", "Body text");
    expect(a).toHaveLength(32);
    expect(a.equals(contentHash("Headline", "Body text"))).toBe(true);
  });

  it("ignores whitespace runs and Unicode composition, not content or case", () => {
    const base = contentHash("Café prices", "Body text");
    expect(base.equals(contentHash("  Café   prices ", "Body\n text"))).toBe(
      true,
    );
    expect(base.equals(contentHash("Café prices", "Body text!"))).toBe(false);
    expect(base.equals(contentHash("café prices", "Body text"))).toBe(false);
  });

  it("does not confuse where the headline ends", () => {
    expect(contentHash("a b", "c").equals(contentHash("a", "b c"))).toBe(false);
  });
});
