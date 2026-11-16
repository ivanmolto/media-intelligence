import { describe, expect, it } from "vitest";
import {
  decodeCursor,
  encodeCursor,
  filterHash,
  InvalidCursorError,
} from "@/lib/articles/cursor";

const position = { ts: "2026-07-14T08:30:00.000000Z", id: "42" };
const hash = filterHash({ source: "Reuters" });

const encodeRaw = (value: unknown) =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

describe("filterHash", () => {
  it("does not depend on key order or on undefined keys", () => {
    expect(filterHash({ a: "1", b: "2" })).toBe(filterHash({ b: "2", a: "1" }));
    expect(filterHash({ a: "1", b: undefined })).toBe(filterHash({ a: "1" }));
  });

  it("differs when a value differs", () => {
    expect(filterHash({ source: "Reuters" })).not.toBe(
      filterHash({ source: "Bloomberg" }),
    );
    expect(filterHash({})).not.toBe(filterHash({ source: "Reuters" }));
  });
});

describe("cursor", () => {
  it("round-trips a position, microseconds included", () => {
    const micro = { ts: "2026-07-14T08:30:00.123456Z", id: "9007199254740993" };
    expect(decodeCursor(encodeCursor(micro, hash), hash)).toEqual(micro);
    expect(decodeCursor(encodeCursor(position, hash), hash)).toEqual(position);
  });

  it("rejects a cursor made for other filters", () => {
    const other = filterHash({ source: "Bloomberg" });
    expect(() => decodeCursor(encodeCursor(position, hash), other)).toThrow(
      InvalidCursorError,
    );
  });

  it("carries the code the API maps to 400", () => {
    try {
      decodeCursor("garbage", hash);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidCursorError);
      expect((error as InvalidCursorError).code).toBe("invalid_cursor");
    }
  });

  it.each([
    ["empty", ""],
    ["not base64", "!!!"],
    ["not JSON", Buffer.from("nope").toString("base64url")],
    ["JSON null", encodeRaw(null)],
    ["an array", encodeRaw([1, 2])],
    ["missing id", encodeRaw({ ts: position.ts, filter_hash: hash })],
    ["numeric id", encodeRaw({ ...position, id: 42, filter_hash: hash })],
    ["negative id", encodeRaw({ ...position, id: "-1", filter_hash: hash })],
    [
      "id with SQL",
      encodeRaw({ ...position, id: "1; DROP", filter_hash: hash }),
    ],
    [
      "ts not a timestamp",
      encodeRaw({ ...position, ts: "now()", filter_hash: hash }),
    ],
    [
      "ts month 13",
      encodeRaw({ ...position, ts: "2026-13-01T00:00:00Z", filter_hash: hash }),
    ],
    [
      "ts with offset",
      encodeRaw({
        ...position,
        ts: "2026-07-14T08:30:00+02:00",
        filter_hash: hash,
      }),
    ],
  ])("rejects %s", (_name, text) => {
    expect(() => decodeCursor(text, hash)).toThrow(InvalidCursorError);
  });
});
