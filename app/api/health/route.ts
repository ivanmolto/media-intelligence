// Liveness only: it does not touch the database (spec §4).
export function GET(): Response {
  return Response.json({ ok: true });
}
