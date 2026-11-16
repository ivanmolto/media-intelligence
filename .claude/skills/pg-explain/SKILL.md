---
name: pg-explain
description: Run EXPLAIN (ANALYZE, BUFFERS) for the list, search and aggregate queries against the synthetic dataset and report which indexes are used. Use before writing any README claim about indexes or query performance, and after any migration that adds, drops or changes an index.
---

# pg-explain

## Inputs

- **Database:** the synthetic database only, from `SYNTHETIC_DATABASE_URL`. Never `DATABASE_URL`.
- **Queries:** `scripts/explain-queries.json`. `npm run db:explain` runs every case in it. This skill holds no query list: do not copy cases into it or run a query that is not in the file.
- **Output:** `npm run db:explain` writes the plans to `docs/evaluations/explain.txt`. README text is pasted from that file.

## Steps

1. Check the target database. Proceed only if the database name in `SYNTHETIC_DATABASE_URL` is `media_synthetic`. If the variable is unset, or names the app database or `media_test`, stop and say what it points at — this skill bulk-inserts rows, and the app database must keep its 20 articles. The host is not the test: inside compose it is `db`, outside it is `localhost`.
2. Ensure synthetic rows exist. Count `articles` first; run `npm run db:synthetic` (≈200k articles with matching enrichment rows) only if the count is below 200k. If the script is missing, say so and stop — do not claim index usage from 20 rows.
3. Check the data can answer the questions. Stop and report a finding if any of these is zero:
   - articles joined to an enrichment row for the active run key (grouped aggregates and the `sentiment` / `topic` filters depend on it);
   - rows matching each search case in the queries file.
4. Run `VACUUM (ANALYZE)` on `articles` and `article_enrichments`, so planner statistics and the visibility map are current.
5. Run `npm run db:explain`. It runs each case twice and records the second run, so timings and buffer counts are warm-cache and comparable between runs.
6. Check coverage against the five indexes in spec §1. Each must be exercised by at least one case, or be named as unmeasured:

   | Index                                             | Exercised by                                        |
   | ------------------------------------------------- | --------------------------------------------------- |
   | `articles (published_at desc, id desc)`           | unfiltered list, first page and a deep cursor page  |
   | `articles (source, published_at desc, id desc)`   | list filtered by `source`                           |
   | `articles (language, published_at desc, id desc)` | list filtered by `language`                         |
   | `articles using gin (tsv)`                        | search: term, phrase, prefix, and search + filter   |
   | `article_enrichments using gin (tags)`            | list filtered by `topic`                            |
   | dedup partial index on `article_enrichments`      | not a route query — report as **unmeasured** unless a case covers the worker's lookup |

   A missing category is a finding about the queries file, not something to work around by hand.
7. For each case, report:
   - the scan node(s) and index name if any — not just the top node, which is usually `Limit`;
   - for search, the scan node of **each** language branch (`english` and `simple`);
   - whether a `Sort` node is present (for list queries, an index that filters but does not provide the order is a finding);
   - estimated vs actual rows, and `Rows Removed by Filter`;
   - execution time, shared buffers hit/read;
   - for search: matching rows against total rows, so selectivity is visible.
8. Head the report with the Postgres version, the `articles` row count, the active run key, the commit hash and whether the working tree was clean, so any README claim can be traced to this run. State the number of cases in the file and the number run; they must be equal.

## Rules

- `db:explain` must build its SQL with the same query builders the routes use, with the same parameters. If it uses hand-copied SQL, report that as a finding and make no claims about the app from those plans.
- Write "uses the index" in the README **only** if `Index Scan`, `Index Only Scan` or `Bitmap Index Scan` on that index appears in the plan in `docs/evaluations/explain.txt`. Otherwise write one of:
  - "seq scan on this dataset size" and say why, when a selective query could use an index but the planner declines; or
  - "seq scan expected: the query reads all rows", for whole-table aggregates; or
  - "designed, unmeasured", for an index no case exercises.
- If this skill has not been run — phase 5 is on the cut list — the README says the indexes are designed but unmeasured and never claims they are used (spec §1).
- Quote plan text from the output file; do not summarise from memory.
- A search case that matches zero rows proves nothing about the index. Report it as a finding about the synthetic data, not as a result.
- If the planner ignores an index you expected, report it as a finding with the likely cause (column order, selectivity, unrealistic term frequency in the synthetic data, stale statistics) — don't add `enable_seqscan = off` to the application.
- Never run EXPLAIN on a query built with string interpolation.
- Adding or changing a case in `scripts/explain-queries.json` is a human decision. Propose it; do not edit the file to make coverage pass.
