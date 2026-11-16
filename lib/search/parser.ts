// Tokens → AST, by recursive descent over the grammar of spec §2:
//
//   query := or
//   or    := and ( "OR" and )*
//   and   := unary ( ( "AND" | "AND" "NOT" )? unary )*     -- adjacency = AND
//   unary := "(" or ")" | PHRASE | PREFIX | TERM
//
// AND and AND NOT bind tighter than OR; all three are left-associative.
import type { Node } from "./ast";
import { InvalidQueryError, shown, type Token, tokenize } from "./lexer";

export { InvalidQueryError };

/** S4. Length is counted in characters, before anything is trimmed. */
export const MAX_LENGTH = 500;
/** S4, "≤ 32 terms": terms, prefixes and phrases; a phrase counts once. */
export const MAX_LEAVES = 32;
/** S4: depth of nested brackets. */
export const MAX_DEPTH = 8;

const NAME = { and: "AND", or: "OR", not: "NOT" } as const;

function describe(token: Token | undefined): string {
  if (!token) return "the end of the query";
  switch (token.type) {
    case "lparen":
      return "'('";
    case "rparen":
      return "')'";
    case "and":
    case "or":
    case "not":
      return NAME[token.type];
    case "term":
      return shown(token.text);
    case "prefix":
      return shown(token.text + "*");
    case "phrase":
      return shown('"' + token.text + '"');
  }
}

export function parseQuery(query: string): Node {
  if ([...query].length > MAX_LENGTH) {
    throw new InvalidQueryError(
      `the query is longer than ${MAX_LENGTH} characters`,
    );
  }
  const tokens = tokenize(query);
  if (tokens.length === 0) throw new InvalidQueryError("the query is empty");

  let position = 0;
  let depth = 0;
  let leaves = 0;
  const peek = (): Token | undefined => tokens[position];

  function unary(): Node {
    const token = peek();
    if (token?.type === "lparen") {
      position += 1;
      depth += 1;
      if (depth > MAX_DEPTH) {
        throw new InvalidQueryError(
          `brackets are nested more than ${MAX_DEPTH} deep`,
        );
      }
      const inner = or();
      if (peek()?.type !== "rparen") {
        throw new InvalidQueryError(
          `a bracket is opened but never closed: expected ')' before ${describe(peek())}`,
        );
      }
      position += 1;
      depth -= 1;
      return inner;
    }
    if (
      token?.type === "term" ||
      token?.type === "prefix" ||
      token?.type === "phrase"
    ) {
      position += 1;
      leaves += 1;
      if (leaves > MAX_LEAVES) {
        throw new InvalidQueryError(
          `the query has more than ${MAX_LEAVES} terms`,
        );
      }
      return { type: token.type, text: token.text };
    }
    if (token?.type === "not") {
      throw new InvalidQueryError(
        "NOT is only allowed after AND, as in a AND NOT b",
      );
    }
    const before = tokens[position - 1];
    throw new InvalidQueryError(
      before
        ? `expected a term after ${describe(before)}, found ${describe(token)}`
        : `expected a term, found ${describe(token)}`,
    );
  }

  function and(): Node {
    let left = unary();
    for (;;) {
      const token = peek();
      if (token?.type === "and") {
        position += 1;
        if (peek()?.type === "not") {
          position += 1;
          left = { type: "and_not", left, right: unary() };
        } else {
          left = { type: "and", left, right: unary() };
        }
      } else if (
        token?.type === "lparen" ||
        token?.type === "term" ||
        token?.type === "prefix" ||
        token?.type === "phrase"
      ) {
        left = { type: "and", left, right: unary() };
      } else {
        return left;
      }
    }
  }

  function or(): Node {
    let left = and();
    while (peek()?.type === "or") {
      position += 1;
      left = { type: "or", left, right: and() };
    }
    return left;
  }

  const root = or();
  const rest = peek();
  if (rest?.type === "rparen") {
    throw new InvalidQueryError("a bracket is closed but was never opened");
  }
  if (rest?.type === "not") {
    throw new InvalidQueryError(
      "NOT is only allowed after AND, as in a AND NOT b",
    );
  }
  if (rest) {
    throw new InvalidQueryError(`unexpected ${describe(rest)}`);
  }
  return root;
}
