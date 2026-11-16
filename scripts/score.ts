// npm run score — compares one run key's rows with tests/golden.json (spec §7).
// The model is ENRICH_MODEL if set, otherwise mock; LLM_MODE is not read.
import { readFileSync } from "node:fs";
import { getPool } from "../lib/db";
import { readOnlyRunKey } from "../lib/enrich/provider";
import { SENTIMENTS, TAXONOMY } from "../lib/enrich/taxonomy";

type Label = {
  external_id: number;
  sentiment: string;
  acceptable_tags: string[];
};
type Row = {
  external_id: number;
  status: string;
  sentiment: string | null;
  tags: string[] | null;
};

async function main(): Promise<number> {
  const key = readOnlyRunKey();
  const params = [key.requestedModel, key.promptVersion, key.taxonomyVersion];
  console.log(`run key: ${params.join(" / ")}`);

  const file = new URL("../tests/golden.json", import.meta.url);
  const { labels } = JSON.parse(readFileSync(file, "utf8")) as {
    labels: Label[];
  };
  const unlabelled = labels.filter(
    (l) =>
      !(SENTIMENTS as readonly string[]).includes(l.sentiment) ||
      l.acceptable_tags.length === 0 ||
      l.acceptable_tags.some(
        (t) => !(TAXONOMY as readonly string[]).includes(t),
      ),
  );
  if (unlabelled.length > 0) {
    console.error(
      `score: tests/golden.json is not fully labelled: ${unlabelled.length} of ${labels.length} entries are empty or outside the enums`,
    );
    return 1;
  }

  const pool = getPool();
  const { rows } = await pool
    .query<Row>(
      `SELECT a.external_id, e.status, e.sentiment, e.tags
         FROM article_enrichments e JOIN articles a ON a.id = e.article_id
        WHERE e.requested_model = $1 AND e.prompt_version = $2 AND e.taxonomy_version = $3`,
      params,
    )
    .finally(() => pool.end());
  const byId = new Map(rows.map((r) => [r.external_id, r]));

  let sentiment = 0;
  let tags = 0;
  for (const label of labels) {
    const row = byId.get(label.external_id);
    const done = row?.status === "done";
    const sentimentOk = done && row.sentiment === label.sentiment;
    const tagsOk =
      done && (row.tags ?? []).every((t) => label.acceptable_tags.includes(t));
    if (sentimentOk) sentiment++;
    if (tagsOk) tags++;
    if (!sentimentOk || !tagsOk) {
      console.log(
        `article ${label.external_id}: ${row?.status ?? "no row"}; sentiment ${row?.sentiment ?? "null"} (golden ${label.sentiment}); tags [${row?.tags ?? ""}] (acceptable [${label.acceptable_tags}])`,
      );
    }
  }
  console.log(
    `sentiment agreement: ${sentiment} / ${labels.length} (a row that is not done counts as a miss)`,
  );
  console.log(
    `tag validity: ${tags} / ${labels.length} (valid = the row is done and every tag it has is in the article's acceptable_tags)`,
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
