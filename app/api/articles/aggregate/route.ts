// GET /api/articles/aggregate — a wrapper; parameters, queries and errors are in lib/api/.
import { aggregateResponse } from "@/lib/api/handlers";

export function GET(request: Request): Promise<Response> {
  return aggregateResponse(new URL(request.url));
}
