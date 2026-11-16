"use client";

// The search page (spec §5). It holds no data logic: the URL is the state, and every
// result, warning and error message comes from GET /api/articles as returned.
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import type { ArticleItem } from "@/lib/articles/list";
import { SENTIMENTS, TAXONOMY } from "@/lib/enrich/taxonomy";
import { ArticleCard, topicLabel } from "./ArticleCard";

/** The filters both pages carry in the URL and pass to the API unchanged. */
export const FILTER_KEYS = [
  "q",
  "source",
  "language",
  "sentiment",
  "topic",
  "from",
  "to",
] as const;

/** The known, non-empty filters of a URL, in a fixed order. */
export function filterQuery(params: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const value = params.get(key);
    if (value) out.set(key, value);
  }
  return out;
}

export type Fetched<T> = { ok: true; data: T } | { ok: false; message: string };

/** GET a JSON endpoint; a 4xx/5xx gives the API's own `error.message`. */
export async function getJson<T>(
  path: string,
  signal?: AbortSignal,
): Promise<Fetched<T>> {
  let res: Response;
  try {
    res = await fetch(path, { signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ok: false, message: "Could not reach the server." };
  }
  const body: unknown = await res.json().catch(() => null);
  if (res.ok && body !== null) return { ok: true, data: body as T };
  const message = (body as { error?: { message?: unknown } } | null)?.error
    ?.message;
  return {
    ok: false,
    message: typeof message === "string" ? message : "The request failed.",
  };
}

export function Warnings({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <ul className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
      {warnings.map((leaf) => (
        <li key={leaf}>&lsquo;{leaf}&rsquo; was ignored as a stop word</li>
      ))}
    </ul>
  );
}

export function ErrorMessage({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800"
    >
      {message}
    </p>
  );
}

// Small on purpose: with 20 articles, a page of 5 makes "Load more" visible.
const PAGE_SIZE = 5;

type ListBody = {
  items: ArticleItem[];
  next_cursor: string | null;
  warnings: string[];
};
type Loaded =
  | {
      key: string;
      ok: true;
      items: ArticleItem[];
      nextCursor: string | null;
      warnings: string[];
      moreError?: string;
    }
  | { key: string; ok: false; message: string };

const apiPath = (key: string, cursor?: string) => {
  const params = new URLSearchParams(key);
  params.set("limit", String(PAGE_SIZE));
  if (cursor) params.set("cursor", cursor);
  return "/api/articles?" + params.toString();
};

function SearchForm({ params }: { params: URLSearchParams }) {
  const router = useRouter();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [sentiment, setSentiment] = useState(params.get("sentiment") ?? "");
  const [topic, setTopic] = useState(params.get("topic") ?? "");

  function submit(event: FormEvent) {
    event.preventDefault();
    // filters this form has no control for (source, language, from, to) stay in the URL
    const next = new URLSearchParams(params);
    for (const [key, value] of [
      ["q", q.trim()],
      ["sentiment", sentiment],
      ["topic", topic],
    ] as const) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    router.push("/?" + filterQuery(next).toString());
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <div className="flex gap-2">
        <input
          type="search"
          name="q"
          value={q}
          onChange={(event) => setQ(event.target.value)}
          maxLength={500}
          placeholder='"oil prices" AND (geopolitical OR "supply chain")'
          aria-label="Boolean query"
          className="min-w-0 flex-1 rounded border border-gray-300 px-3 py-2 font-mono text-sm"
        />
        <button
          type="submit"
          className="rounded bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-800"
        >
          Search
        </button>
      </div>
      <div className="flex flex-wrap gap-2 text-sm">
        <select
          value={sentiment}
          onChange={(event) => setSentiment(event.target.value)}
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
        <select
          value={topic}
          onChange={(event) => setTopic(event.target.value)}
          aria-label="Topic"
          className="rounded border border-gray-300 px-2 py-1"
        >
          <option value="">Any topic</option>
          {TAXONOMY.map((value) => (
            <option key={value} value={value}>
              {topicLabel(value)}
            </option>
          ))}
        </select>
      </div>
      <p className="text-xs text-gray-500">
        Operators are upper case: AND, OR, AND NOT. Also ( ), &quot;a
        phrase&quot; and prefix*. Lower-case &lsquo;and&rsquo; is a word.
      </p>
    </form>
  );
}

export function SearchView() {
  const searchParams = useSearchParams();
  const filters = filterQuery(searchParams);
  const key = filters.toString();

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    getJson<ListBody>(apiPath(key), controller.signal).then(
      (result) =>
        setLoaded(
          result.ok
            ? {
                key,
                ok: true,
                items: result.data.items,
                nextCursor: result.data.next_cursor,
                warnings: result.data.warnings,
              }
            : { key, ok: false, message: result.message },
        ),
      () => {}, // aborted: a newer request owns the state
    );
    return () => controller.abort();
  }, [key]);

  // What is on screen belongs to the URL's filters, or it is still loading.
  const current = loaded?.key === key ? loaded : null;

  async function loadMore(cursor: string) {
    setLoadingMore(true);
    const result = await getJson<ListBody>(apiPath(key, cursor));
    setLoaded((previous) => {
      if (!previous || previous.key !== key || !previous.ok) return previous;
      if (!result.ok) return { ...previous, moreError: result.message };
      return {
        ...previous,
        items: [...previous.items, ...result.data.items],
        nextCursor: result.data.next_cursor,
        moreError: undefined,
      };
    });
    setLoadingMore(false);
  }

  return (
    <div className="flex flex-col gap-4">
      <SearchForm key={key} params={filters} />
      <p className="text-sm">
        <Link
          href={"/trends" + (key ? "?" + key : "")}
          className="text-blue-700 hover:underline"
        >
          See these results as a trend
        </Link>
      </p>

      {current === null && <p className="text-sm text-gray-500">Loading…</p>}
      {current?.ok === false && <ErrorMessage message={current.message} />}
      {current?.ok && (
        <>
          <Warnings warnings={current.warnings} />
          {current.items.length === 0 ? (
            <p className="text-sm text-gray-700">0 results</p>
          ) : (
            <>
              <p className="text-sm text-gray-600">
                {current.items.length} shown
                {current.nextCursor ? ", more available" : ""}
              </p>
              <div className="flex flex-col gap-3">
                {current.items.map((item) => (
                  <ArticleCard key={item.id} item={item} />
                ))}
              </div>
            </>
          )}
          {current.moreError && <ErrorMessage message={current.moreError} />}
          {current.nextCursor && (
            <button
              type="button"
              disabled={loadingMore}
              onClick={() => loadMore(current.nextCursor!)}
              className="self-start rounded border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50 disabled:opacity-50"
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          )}
        </>
      )}
    </div>
  );
}
