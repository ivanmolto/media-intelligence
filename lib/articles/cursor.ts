// Keyset cursor: base64url of {ts, id, filter_hash} (spec §1, Pagination).
//
// - `ts` is the row's published_at as text with microseconds, not a JS Date: a
//   millisecond round-trip would skip or repeat rows that share a millisecond.
// - `id` is the row's internal id, as a string (bigint).
// - The cursor is not signed. There is no auth, so a forged cursor only moves the
//   position in a public list; both fields are checked before they reach a query.
import { createHash } from "node:crypto";

export class InvalidCursorError extends Error {
  readonly code = "invalid_cursor";
  constructor(message: string) {
    super(message);
    this.name = "InvalidCursorError";
  }
}

export type CursorPosition = { ts: string; id: string };

const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const ID = /^\d{1,18}$/;

/** Hash of a filter set: the same filters give the same hash whatever the key order. */
export function filterHash(filters: Record<string, unknown>): string {
  const canonical = Object.keys(filters)
    .sort()
    .filter((key) => filters[key] !== undefined)
    .map((key) => [key, filters[key]]);
  return createHash("sha256")
    .update(JSON.stringify(canonical), "utf8")
    .digest("hex")
    .slice(0, 16);
}

export function encodeCursor(position: CursorPosition, hash: string): string {
  const payload = { ts: position.ts, id: position.id, filter_hash: hash };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeCursor(text: string, hash: string): CursorPosition {
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
  } catch {
    throw new InvalidCursorError("cursor is not readable");
  }
  if (typeof payload !== "object" || payload === null) {
    throw new InvalidCursorError("cursor is not readable");
  }
  const { ts, id, filter_hash } = payload as Record<string, unknown>;
  if (
    typeof ts !== "string" ||
    !TS.test(ts) ||
    // the pattern admits month 13; the first 19 characters are a plain ISO time
    Number.isNaN(Date.parse(ts.slice(0, 19) + "Z")) ||
    typeof id !== "string" ||
    !ID.test(id)
  ) {
    throw new InvalidCursorError("cursor is not readable");
  }
  if (filter_hash !== hash) {
    throw new InvalidCursorError(
      "cursor was issued for different filters; start again from the first page",
    );
  }
  return { ts, id };
}
