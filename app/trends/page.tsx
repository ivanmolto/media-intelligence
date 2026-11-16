// The trends page: a shell. The view fetches GET /api/articles/aggregate from the browser.
import { Suspense } from "react";
import { TrendsView } from "@/components/TrendsView";

export default function TrendsPage() {
  return (
    <>
      <h1 className="mb-4 text-xl font-semibold">Trends</h1>
      {/* useSearchParams needs a Suspense boundary */}
      <Suspense fallback={<p className="text-sm text-gray-500">Loading…</p>}>
        <TrendsView />
      </Suspense>
    </>
  );
}
