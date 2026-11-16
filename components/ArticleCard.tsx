// One search result. Every piece of article text and model output is a React text
// node: React escapes it, so the markup in articles 6 and 18 is shown, not run.
// No hooks, so it also renders on the server and under renderToStaticMarkup.
import type { ArticleItem } from "@/lib/articles/list";
import { SentimentBadge } from "./SentimentBadge";

/** Topic ids are English ids from the taxonomy; the UI only changes their case. */
export function topicLabel(id: string): string {
  return id === "ai" ? "AI" : id.charAt(0).toUpperCase() + id.slice(1);
}

export function ArticleCard({ item }: { item: ArticleItem }) {
  const enrichment = item.enrichment;
  const done = enrichment?.status === "done";
  return (
    <article className="rounded border border-gray-200 p-4">
      <h2 className="font-semibold">
        {item.headline.trim() === "" ? (
          <span className="text-gray-500">(Untitled)</span>
        ) : (
          item.headline
        )}
      </h2>
      <p className="mt-1 text-sm text-gray-600">
        {item.source} · {item.published_at.slice(0, 10)} · {item.language}
      </p>
      {done ? (
        <>
          {enrichment.summary !== null && (
            <p className="mt-2 text-sm">{enrichment.summary}</p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <SentimentBadge sentiment={enrichment.sentiment} />
            {(enrichment.tags ?? []).map((tag) => (
              <span
                key={tag}
                className="rounded border border-gray-300 px-2 py-0.5 text-xs"
              >
                {topicLabel(tag)}
              </span>
            ))}
          </div>
        </>
      ) : (
        <p className="mt-2 text-sm text-gray-500 italic">
          {enrichment?.status === "failed"
            ? "Enrichment failed"
            : "Not enriched yet"}
        </p>
      )}
    </article>
  );
}
