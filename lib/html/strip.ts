// Produces `body_text` from an article body: the text that search indexes and the
// LLM reads. The raw body is stored next to it, unchanged.
//
// This is not a sanitizer and its output is not safe to render as HTML: decoded
// entities can spell a tag again. Everything is rendered as React text nodes.

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntity(match: string, body: string): string {
  if (body[0] !== "#") return NAMED[body.toLowerCase()] ?? match;
  const hex = body[1] === "x" || body[1] === "X";
  const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff
    ? String.fromCodePoint(code)
    : match;
}

export function stripHtml(html: string): string {
  return (
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      // script and style go with their contents: code is not article text
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
      // a tag starts with a letter, so "3 < 5" is left alone. Replaced by a space,
      // not nothing: "<p>a</p><p>b</p>" must not become one word
      .replace(/<\/?[a-zA-Z][^>]*>/g, " ")
      .replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, decodeEntity)
      .replace(/\s+/g, " ")
      .trim()
  );
}
