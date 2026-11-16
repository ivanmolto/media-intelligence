// GET /api/articles — a wrapper; parameters, queries and errors are in lib/api/.
import { articlesResponse } from "@/lib/api/handlers";

export function GET(request: Request): Promise<Response> {
  return articlesResponse(new URL(request.url));
}
