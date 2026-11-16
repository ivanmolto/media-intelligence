"use client";

// The trends page (spec §5): counts per week or month for the same `q` and filters
// as the search page, read from the URL and passed to GET /api/articles/aggregate.
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { SENTIMENTS } from "@/lib/enrich/taxonomy";
import { ErrorMessage, filterQuery, getJson, Warnings } from "./SearchView";
import { type ChartRow, TrendsChart } from "./TrendsChart";

const BUCKETS = ["week", "month"] as const;
type Bucket = (typeof BUCKETS)[number];

type AggregateBody = {
  buckets: ChartRow[];
  warnings: string[];
  notes: string[];
};
type Loaded =
  | { key: string; ok: true; rows: ChartRow[]; warnings: string[] }
  | { key: string; ok: false; message: string };

export function TrendsView() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const filters = filterQuery(searchParams);
  const bucket: Bucket =
    searchParams.get("bucket") === "month" ? "month" : "week";
  const sentiment = filters.get("sentiment") ?? "";
  const filterKey = filters.toString();
  const key = filterKey + "|" + bucket;

  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams(filterKey);
    params.set("bucket", bucket);
    getJson<AggregateBody>(
      "/api/articles/aggregate?" + params.toString(),
      controller.signal,
    ).then(
      (result) =>
        setLoaded(
          result.ok
            ? {
                key,
                ok: true,
                rows: result.data.buckets,
                warnings: result.data.warnings,
              }
            : { key, ok: false, message: result.message },
        ),
      () => {}, // aborted: a newer request owns the state
    );
    return () => controller.abort();
  }, [key, filterKey, bucket]);

  const current = loaded?.key === key ? loaded : null;

  /** Changes one value in the URL; the URL change is what refetches. */
  function set(name: "bucket" | "sentiment", value: string) {
    const next = new URLSearchParams(filterKey);
    if (name === "sentiment") {
      if (value) next.set("sentiment", value);
      else next.delete("sentiment");
    }
    // week is the default and stays out of the URL
    if ((name === "bucket" ? value : bucket) === "month") {
      next.set("bucket", "month");
    }
    const query = next.toString();
    router.replace(pathname + (query ? "?" + query : ""));
  }

  const q = filters.get("q");
  const total = current?.ok
    ? current.rows.reduce((sum, row) => sum + row.count, 0)
    : 0;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-gray-700">
        {q ? (
          <>
            Query: <code className="rounded bg-gray-100 px-1">{q}</code>
          </>
        ) : (
          "All articles"
        )}
        {" · "}
        <Link
          href={"/" + (filterKey ? "?" + filterKey : "")}
          className="text-blue-700 hover:underline"
        >
          Back to results
        </Link>
      </p>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <div role="group" aria-label="Bucket" className="flex">
          {BUCKETS.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={bucket === value}
              onClick={() => set("bucket", value)}
              className={
                "border border-gray-300 px-3 py-1 first:rounded-l last:rounded-r " +
                (bucket === value
                  ? "bg-blue-700 text-white"
                  : "hover:bg-gray-50")
              }
            >
              By {value}
            </button>
          ))}
        </div>
        <select
          value={sentiment}
          onChange={(event) => set("sentiment", event.target.value)}
          aria-label="Sentiment"
          className="rounded border border-gray-300 px-2 py-1"
        >
          <option value="">Any sentiment</option>
          {SENTIMENTS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </div>

      {current === null && <p className="text-sm text-gray-500">Loading…</p>}
      {current?.ok === false && <ErrorMessage message={current.message} />}
      {current?.ok && (
        <>
          <Warnings warnings={current.warnings} />
          {current.rows.length === 0 ? (
            <p className="text-sm text-gray-700">0 articles match</p>
          ) : (
            <>
              <p className="text-sm text-gray-600">
                {total} {total === 1 ? "article" : "articles"} in{" "}
                {current.rows.length}{" "}
                {current.rows.length === 1 ? bucket : bucket + "s"}
              </p>
              <TrendsChart rows={current.rows} />
              <p className="text-xs text-gray-500">
                Each bar is labelled with the first day of its {bucket}, in UTC
                {bucket === "week" ? "; weeks start on Monday" : ""}. A {bucket}{" "}
                with no matching article has no bar.
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}
