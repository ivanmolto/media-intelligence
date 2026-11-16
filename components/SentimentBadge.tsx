// One badge per sentiment value. No value → no badge: a missing or failed
// enrichment is never shown as `neutral`.
const STYLES: Record<string, string> = {
  positive: "bg-green-100 text-green-800",
  negative: "bg-red-100 text-red-800",
  neutral: "bg-gray-100 text-gray-800",
  mixed: "bg-amber-100 text-amber-800",
};

export function SentimentBadge({ sentiment }: { sentiment: string | null }) {
  if (sentiment === null) return null;
  return (
    <span
      className={
        "rounded px-2 py-0.5 text-xs font-medium " +
        (STYLES[sentiment] ?? "bg-gray-100 text-gray-800")
      }
    >
      {sentiment}
    </span>
  );
}
