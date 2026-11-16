// The search page: a shell. The view fetches GET /api/articles from the browser.
import { Suspense } from "react";
import { SearchView } from "@/components/SearchView";

export default function SearchPage() {
  return (
    <>
      <h1 className="mb-4 text-xl font-semibold">Search</h1>
      {/* useSearchParams needs a Suspense boundary */}
      <Suspense fallback={<p className="text-sm text-gray-500">Loading…</p>}>
        <SearchView />
      </Suspense>
    </>
  );
}
