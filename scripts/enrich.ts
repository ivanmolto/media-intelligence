// npm run enrich [-- --force] — enriches the articles for the active run key
// (LLM_MODE=mock → 'mock'; live → ENRICH_MODEL). Run by the `init` service after
// the seed. Exit codes: 0 done, 2 budget_exceeded, 1 other error.
import { getPool } from "../lib/db";
import { enrichCommand } from "../lib/enrich/worker";

async function main(): Promise<number> {
  const pool = getPool();
  try {
    return await enrichCommand(pool, process.env, process.argv.slice(2));
  } finally {
    await pool.end();
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
