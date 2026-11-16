// npm run eval:metrics — runs scripts/enrichment-metrics.sql for one run key and
// prints the key first. The model is ENRICH_MODEL if set, otherwise mock; LLM_MODE
// is not read and no key is needed (deviation 8).
import { readFileSync } from "node:fs";
import { getPool } from "../lib/db";
import { readOnlyRunKey } from "../lib/enrich/provider";

async function main(): Promise<void> {
  const key = readOnlyRunKey();
  const params = [key.requestedModel, key.promptVersion, key.taxonomyVersion];
  console.log(`run key: ${params.join(" / ")}`);
  // The file is a constant from the repo; the run key goes in as parameters.
  const sql = readFileSync(
    new URL("./enrichment-metrics.sql", import.meta.url),
    "utf8",
  );
  const pool = getPool();
  try {
    const { rows } = await pool.query(sql, params);
    for (const [name, value] of Object.entries(rows[0] ?? {})) {
      console.log(`${name}: ${value === null ? "null" : String(value)}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
