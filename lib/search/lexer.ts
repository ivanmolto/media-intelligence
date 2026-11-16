// Query text → tokens (spec §2, Grammar):
//
//   PHRASE := '"' [^"]+ '"'
//   PREFIX := TERM '*'
//   TERM   := [^\s()"*]+      -- but not exactly AND / OR / NOT
//
// Operators are case-sensitive (R7): `AND` is an operator, `and` is a term.
// A term, prefix or phrase with no letter or digit is rejected here (deviation 3):
// it has no lexeme under either text-search config, so it could never match.

/** A query the grammar or the limits reject. Maps to HTTP 400 `invalid_query`. */
export class InvalidQueryError extends Error {
  readonly code = "invalid_query";
  constructor(message: string) {
    super(message);
    this.name = "InvalidQueryError";
  }
}

export type Token =
  | { type: "lparen" | "rparen" | "and" | "or" | "not" }
  | { type: "term" | "prefix" | "phrase"; text: string };

const OPERATORS: Record<string, "and" | "or" | "not"> = {
  AND: "and",
  OR: "or",
  NOT: "not",
};
const WORD = /[^\s()"*]+/y;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** Quotes a token for an error message, shortened so a message stays short. */
export function shown(text: string): string {
  const chars = [...text];
  return (
    "'" + (chars.length > 40 ? chars.slice(0, 40).join("") + "…" : text) + "'"
  );
}

function requireLetterOrDigit(text: string, source: string): void {
  if (!LETTER_OR_DIGIT.test(text)) {
    throw new InvalidQueryError(
      `${shown(source)} has no letter or digit to search for`,
    );
  }
}

export function tokenize(query: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < query.length) {
    const char = query[i]!;
    if (/\s/.test(char)) {
      i += 1;
    } else if (char === "(") {
      tokens.push({ type: "lparen" });
      i += 1;
    } else if (char === ")") {
      tokens.push({ type: "rparen" });
      i += 1;
    } else if (char === '"') {
      const end = query.indexOf('"', i + 1);
      if (end === -1) {
        throw new InvalidQueryError("a quote is opened but never closed");
      }
      const text = query.slice(i + 1, end);
      if (text === "") throw new InvalidQueryError('"" is an empty phrase');
      requireLetterOrDigit(text, '"' + text + '"');
      tokens.push({ type: "phrase", text });
      i = end + 1;
    } else if (char === "*") {
      throw new InvalidQueryError(
        "'*' is only allowed at the end of a term, as in renew*",
      );
    } else {
      WORD.lastIndex = i;
      const text = WORD.exec(query)![0];
      i += text.length;
      const star = query[i] === "*";
      const operator = Object.hasOwn(OPERATORS, text)
        ? OPERATORS[text]
        : undefined;
      if (operator && star) {
        throw new InvalidQueryError(
          `'*' cannot follow the operator ${text}; operators are upper case, terms are not`,
        );
      }
      if (operator) {
        tokens.push({ type: operator });
      } else if (star) {
        requireLetterOrDigit(text, text + "*");
        tokens.push({ type: "prefix", text });
        i += 1;
      } else {
        requireLetterOrDigit(text, text);
        tokens.push({ type: "term", text });
      }
    }
  }
  return tokens;
}
