// The boolean query as a tree (spec §2, Grammar). Leaves hold the user's text and
// nothing else does; the compiler sends each leaf's text as one `$n` parameter.

export type Leaf =
  /** a bare word */
  | { type: "term"; text: string }
  /** `word*`; `text` is the word without the star */
  | { type: "prefix"; text: string }
  /** `"some words"`; `text` is what is between the quotes */
  | { type: "phrase"; text: string };

export type Node =
  | Leaf
  | { type: "and"; left: Node; right: Node }
  | { type: "or"; left: Node; right: Node }
  /** `left AND NOT right` */
  | { type: "and_not"; left: Node; right: Node };

export function isLeaf(node: Node): node is Leaf {
  return (
    node.type === "term" || node.type === "prefix" || node.type === "phrase"
  );
}

/** A leaf as the user typed it. This is the text a warning carries. */
export function leafSource(leaf: Leaf): string {
  if (leaf.type === "prefix") return leaf.text + "*";
  if (leaf.type === "phrase") return '"' + leaf.text + '"';
  return leaf.text;
}

/** Every leaf, left to right. */
export function leavesOf(node: Node): Leaf[] {
  return isLeaf(node)
    ? [node]
    : [...leavesOf(node.left), ...leavesOf(node.right)];
}

const LABEL = { and: "AND", or: "OR", and_not: "AND-NOT" } as const;

/** The tree on one line, for tests and `npm run search:debug`: `(AND a (OR b c))`. */
export function formatAst(node: Node): string {
  if (isLeaf(node)) return leafSource(node);
  return `(${LABEL[node.type]} ${formatAst(node.left)} ${formatAst(node.right)})`;
}
