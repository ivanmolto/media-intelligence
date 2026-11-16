// The API's error shape, {error: {code, message}}, and the one place a thrown error
// becomes a response (spec §4, as amended by deviations 2 and 3).
//
// Codes: invalid_query, invalid_cursor, invalid_param (400) and internal (500).
// A 400 message is written by this codebase: the parser's, the cursor's or the
// parameter rule's. Anything else is logged on the server and answered with a fixed
// message, so no SQL, driver or provider text reaches a response.
import { InvalidCursorError } from "../articles/cursor";
import { InvalidQueryError } from "../search/lexer";

/** A request parameter the rules in params.ts reject. Maps to HTTP 400 `invalid_param`. */
export class ParamError extends Error {
  readonly code = "invalid_param";
  constructor(message: string) {
    super(message);
    this.name = "ParamError";
  }
}

export type ErrorCode =
  "invalid_query" | "invalid_cursor" | "invalid_param" | "internal";

export type ErrorBody = { error: { code: ErrorCode; message: string } };

const body = (code: ErrorCode, message: string): ErrorBody => ({
  error: { code, message },
});

export function errorResponse(error: unknown): Response {
  if (
    error instanceof InvalidQueryError ||
    error instanceof InvalidCursorError ||
    error instanceof ParamError
  ) {
    return Response.json(body(error.code, error.message), { status: 400 });
  }
  console.error("[api] internal error:", error);
  return Response.json(body("internal", "internal error"), { status: 500 });
}
