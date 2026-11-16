// Lexer and parser for the boolean query grammar (spec §2). No database.
import { describe, expect, it } from "vitest";
import { formatAst } from "@/lib/search/ast";
import {
  InvalidQueryError,
  MAX_DEPTH,
  MAX_LEAVES,
  MAX_LENGTH,
  parseQuery,
} from "@/lib/search/parser";

/** The AST on one line: `(AND a (OR b c))`, leaves as typed. */
const parsed = (query: string): string => formatAst(parseQuery(query));

function rejected(query: string): InvalidQueryError {
  try {
    parseQuery(query);
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidQueryError);
    return error as InvalidQueryError;
  }
  throw new Error(`expected ${JSON.stringify(query)} to be rejected`);
}

describe("leaves", () => {
  it("builds the AST as plain objects", () => {
    expect(parseQuery('oil AND NOT "supply chain" OR renew*')).toEqual({
      type: "or",
      left: {
        type: "and_not",
        left: { type: "term", text: "oil" },
        right: { type: "phrase", text: "supply chain" },
      },
      right: { type: "prefix", text: "renew" },
    });
  });

  it.each([
    ["oil", "oil"],
    ["renew*", "renew*"],
    ['"oil prices"', '"oil prices"'],
    ['"healthcare"', '"healthcare"'],
    // quote and operator characters are ordinary term characters (S3)
    ["a'b:c&d*", "a'b:c&d*"],
    ["state-of-the-art", "state-of-the-art"],
    ["دبي", "دبي"],
    ["中国*", "中国*"],
    ["  oil  ", "oil"],
  ])("%s", (query, ast) => {
    expect(parsed(query)).toBe(ast);
  });

  it("keeps a phrase's inner text as typed, operators included", () => {
    expect(parsed('"oil AND (gas)"')).toBe('"oil AND (gas)"');
  });
});

describe("operators are case-sensitive (R7)", () => {
  it.each([
    ["AI AND healthcare", "(AND AI healthcare)"],
    // lowercase operators are terms, joined by adjacency (S5)
    ["AI and healthcare", "(AND (AND AI and) healthcare)"],
    ["oil or gas", "(AND (AND oil or) gas)"],
    ["oil and not gas", "(AND (AND (AND oil and) not) gas)"],
    ["and", "and"],
    ["And", "And"],
    ["Not AI", "(AND Not AI)"],
    // an operator word inside a longer term is a term
    ["ANDROID ORACLE NOTE", "(AND (AND ANDROID ORACLE) NOTE)"],
  ])("%s", (query, ast) => {
    expect(parsed(query)).toBe(ast);
  });
});

describe("precedence and grouping", () => {
  it.each([
    // AND and AND NOT bind tighter than OR
    ["a OR b AND c", "(OR a (AND b c))"],
    ["a AND b OR c", "(OR (AND a b) c)"],
    ["a OR b AND NOT c", "(OR a (AND-NOT b c))"],
    ["a AND NOT b OR c", "(OR (AND-NOT a b) c)"],
    // adjacency binds as AND, so tighter than OR too
    ["a b OR c", "(OR (AND a b) c)"],
    ["a OR b c", "(OR a (AND b c))"],
    // left-associative
    ["a AND b AND c", "(AND (AND a b) c)"],
    ["a OR b OR c", "(OR (OR a b) c)"],
    ["a AND NOT b AND NOT c", "(AND-NOT (AND-NOT a b) c)"],
    ["a AND NOT b c", "(AND (AND-NOT a b) c)"],
    // brackets override
    ["(a OR b) AND c", "(AND (OR a b) c)"],
    ["a AND NOT (b OR c)", "(AND-NOT a (OR b c))"],
    ["((a))", "a"],
    ["(a)(b)", "(AND a b)"],
    ['a"b c"d', '(AND (AND a "b c") d)'],
    // the grammar read literally: PREFIX, then an adjacent TERM
    ["a*b", "(AND a* b)"],
  ])("%s", (query, ast) => {
    expect(parsed(query)).toBe(ast);
  });

  it.each([
    [
      '"oil prices" AND (geopolitical OR "supply chain")',
      '(AND "oil prices" (OR geopolitical "supply chain"))',
    ],
    [
      "renewable AND NOT (nuclear OR coal)",
      "(AND-NOT renewable (OR nuclear coal))",
    ],
    [
      'AI AND ("healthcare" OR "diagnostic") AND NOT startup*',
      '(AND-NOT (AND AI (OR "healthcare" "diagnostic")) startup*)',
    ],
  ])("the brief's example: %s", (query, ast) => {
    expect(parsed(query)).toBe(ast);
  });
});

describe("malformed queries are rejected with invalid_query (S3)", () => {
  it.each([
    ["empty", ""],
    ["whitespace only", "   "],
    ["bare NOT", "NOT AI"],
    ["NOT without AND", "AI NOT energy"],
    ["OR NOT", "AI OR NOT energy"],
    ["double NOT", "AI AND NOT NOT energy"],
    ["leading AND", "AND AI"],
    ["leading OR", "OR AI"],
    ["trailing AND", "AI AND"],
    ["trailing OR", "AI OR"],
    ["trailing AND NOT", "AI AND NOT"],
    ["an operator alone", "AND"],
    ["double operator", "AI OR OR energy"],
    ["AND then OR", "AI AND OR energy"],
    ["unclosed bracket", "(AI OR energy"],
    ["unopened bracket", "AI OR energy)"],
    ["empty brackets", "()"],
    ["operator before a closing bracket", "(AI AND) energy"],
    ["operator after an opening bracket", "(OR AI)"],
    ["unterminated quote", '"oil prices'],
    ["a lone quote", '"'],
    ["empty phrase", '""'],
    ["* alone", "*"],
    ["leading *", "*ai"],
    ["double *", "ai**"],
    ["* after a space", "ai *"],
    ["* after a phrase", '"oil prices"*'],
    ["* after a bracket", "(ai)*"],
    ["* after an operator", "AND*"],
  ])("%s", (_name, query) => {
    const error = rejected(query);
    expect(error.code).toBe("invalid_query");
    expect(error.message).not.toBe("");
  });
});

describe("a leaf needs a letter or a digit (deviation 3)", () => {
  it.each(["!!!", "!!!*", '"!!!"', "AI AND ---", '" "', "(&)", "😀"])(
    "rejects %s",
    (query) => {
      expect(rejected(query).code).toBe("invalid_query");
    },
  );

  it.each(["x!", "!x", "7", "№5", '"!!! a"', "é"])("accepts %s", (query) => {
    expect(() => parseQuery(query)).not.toThrow();
  });
});

describe("limits (S4)", () => {
  const nested = (depth: number) =>
    "(".repeat(depth) + "AI" + ")".repeat(depth);
  const leaves = (n: number) =>
    Array.from({ length: n }, (_, i) => "t" + i).join(" ");

  it("accepts a query of the maximum length and rejects one character more", () => {
    expect(MAX_LENGTH).toBe(500);
    expect(() => parseQuery("a".repeat(MAX_LENGTH))).not.toThrow();
    expect(rejected("a".repeat(MAX_LENGTH + 1)).code).toBe("invalid_query");
  });

  it("counts whitespace padding toward the length", () => {
    expect(rejected("a" + " ".repeat(MAX_LENGTH)).code).toBe("invalid_query");
  });

  it("accepts the maximum number of leaves and rejects one more", () => {
    expect(MAX_LEAVES).toBe(32);
    expect(() => parseQuery(leaves(MAX_LEAVES))).not.toThrow();
    expect(rejected(leaves(MAX_LEAVES + 1)).code).toBe("invalid_query");
  });

  it("counts a phrase as one leaf, whatever its word count", () => {
    const phrase = '"' + leaves(40) + '"';
    expect(() => parseQuery(phrase)).not.toThrow();
  });

  it("accepts the maximum nesting and rejects one level more", () => {
    expect(MAX_DEPTH).toBe(8);
    expect(() => parseQuery(nested(MAX_DEPTH))).not.toThrow();
    expect(rejected(nested(MAX_DEPTH + 1)).code).toBe("invalid_query");
  });

  it("measures nesting, not the number of bracket pairs", () => {
    const flat = Array.from({ length: 12 }, () => "(AI)").join(" OR ");
    expect(() => parseQuery(flat)).not.toThrow();
  });
});

describe("error messages", () => {
  it("never echo more than the offending token", () => {
    const long = "x".repeat(400);
    expect(rejected(long + " AND").message.length).toBeLessThan(120);
  });

  it.each([
    ["NOT AI", /NOT/],
    ["(AI OR energy", /bracket/],
    ['"oil', /quote/],
    ["*ai", /\*/],
    ["!!!", /letter or digit/],
  ])("%s names the problem", (query, pattern) => {
    expect(rejected(query).message).toMatch(pattern);
  });
});
