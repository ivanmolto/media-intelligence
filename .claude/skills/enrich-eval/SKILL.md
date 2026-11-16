---
name: enrich-eval
description: Score one enrichment run key (mock, or a live model Ivan has already run) against tests/golden.json and report agreement, failures, latency, tokens and cost from the article_enrichments rows. Use after changes under lib/enrich/ and for the model comparison in docs/evaluations/README.md. Takes an optional model id; with none it runs and scores mock.
---

# enrich-eval

## Inputs

- **Argument:** an optional model id (for example `anthropic/claude-haiku-5.5`).
  - **None → mock.** The skill re-runs mock enrichment and scores `requested_model = 'mock'`.
  - **A model id → live rows.** The skill scores the rows a human's live run left for that model. It runs nothing that calls a provider.
  - The mode comes from the argument, not from the session's environment. Do not ask, and do not infer a model from `.env`.
- **Run key:** `(requested_model, prompt_version, taxonomy_version)`, spec §1. Each run key has its own rows, so scoring one model never touches another's.
- **Golden labels:** `tests/golden.json`, read by `scripts/score.ts` (`npm run score`). This skill holds no labels and no expected scores.
- **Metrics query:** `scripts/enrichment-metrics.sql`, run by `npm run eval:metrics`. The README pastes the same file. This skill holds no SQL: do not write a metrics query by hand.
- **Prices:** the dated table in `docs/plan.md` §4, or the run-day table in `docs/evaluations/README.md` once it exists. Never a price from memory.
- **Database:** the app database (`DATABASE_URL`, 20 articles).

## Preconditions

- The database name in `DATABASE_URL` is not `media_test` or `media_synthetic`. If it is, stop and say what it points at.
- The database is up, migrated and seeded (`npm run migrate && npm run seed`), and `articles` has 20 rows.
- `npm run enrich`, `npm run score` and `npm run eval:metrics` exist, and `tests/golden.json` parses and has 20 entries.
- If any of these fails, say which and stop. Do not report a table for a setup failure.

## Steps

1. State the mode and the run key being scored, from the argument.
2. Produce the rows, by mode:
   - **Mock:**
     1. Read today's `enrichment_budget.tokens_used` and `DAILY_TOKEN_BUDGET` and report both. Mock runs reserve budget too, and this is the database the UI shows.
     2. `LLM_MODE=mock npm run enrich -- --force`. The variable is set inline so a `live` value in the session cannot reach the worker. This resets only the `mock` run key.
     3. Check the exit code: `0` done, `2` `budget_exceeded`, `1` other. On `2` or `1`, stop: report the status counts, say that the app database now has un-enriched articles, and that `npm run enrich` (no `--force`) finishes the pending rows once the budget allows. Do not edit `enrichment_budget` or raise `DAILY_TOKEN_BUDGET`; that is a human's call.
   - **Live:** run nothing that calls a provider. If the run key has no rows, say so and stop. Never `npm run enrich`, `--force` or `npm run eval:adversarial` for a live model: each is one paid run per model and is not repeated (spec S10).
3. Score, selecting the run key inline and changing nothing else:
   - mock: `env -u ENRICH_MODEL npm run score`
   - live: `ENRICH_MODEL=<model id> npm run score`

   Check that the run key it prints is the one from step 1; if it scored a different key, stop and report that.

4. Metrics, with the same selection: `env -u ENRICH_MODEL npm run eval:metrics` or `ENRICH_MODEL=<model id> npm run eval:metrics`. Check the printed run key again.
5. Report one table for the run key:

   | Metric                                   | Source and definition                                                                                                   |
   | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
   | run key; `model`, `provider` as returned | rows; list every distinct value                                                                                         |
   | done / failed / pending / processing     | status counts; must sum to 20. A `processing` row after the worker has exited is a finding                              |
   | sentiment agreement                      | `npm run score`, as `k / 20`; a `failed` row counts as a miss                                                           |
   | tag validity                             | `npm run score`, as printed; the definition is the scorer's, quote it                                                   |
   | invalid after retry                      | rows with `status = 'failed'` and `error = 'invalid_output'` (decision rule 2)                                          |
   | first-attempt schema-valid rate          | `done` rows with `attempts = 1`, over 20 (deviation 7); "not recorded" if the column is missing                         |
   | adversarial fixtures (decision rule 3)   | live only: validator verdict counts from `docs/evaluations/adversarial-<model>.json`; "not run" if the file is missing  |
   | p50 / p95 latency (ms)                   | `done` rows with a non-null `latency_ms`; state n and why any row is excluded. With n = 20, p95 is close to the maximum |
   | mean input / output tokens               | `done` rows                                                                                                             |
   | cost per article, provider-reported      | mean `cost_usd`; "not reported by provider" if null                                                                     |
   | cost per article, list price             | mean tokens × the dated price table; cite the table and its date                                                        |
   | cost per article, batch list price       | mean tokens × the `:batch` price in `docs/plan.md` §4; a projection — the batch variants are not called in this project |
   | cost per 50,000 articles a day           | each per-article figure × 50,000, labelled a projection                                                                 |

6. List every article whose sentiment or tags differ from golden, with both values, and every `failed` row with its `error`.
7. Read the summaries of the `done` rows and flag any that addresses the reader or gives an instruction. This is a judgement: label it as one. A URL in a `done` summary is not a judgement: the validator should have rejected it, so report it as a validator bug.

## Mock runs

The mock provider returns fixtures whatever the prompt says, so a mock run checks the pipeline (worker, validator, scorer), not a model. Head a mock report with the `provenance` field of `tests/fixtures/mock-enrichments.json`:

- `hand-written`: agreement, tokens and cost are properties of the fixtures. Report them, and say they are not evidence about any model.
- `live`: the numbers replay the named model's recorded run. They should equal that model's row in `docs/evaluations/README.md`; a difference is a finding.

Latency in mock mode is never evidence. A change to `lib/enrich/prompt.ts` cannot move a mock score.

## Rules

- Numbers come from `npm run eval:metrics` and `npm run score` output. Do not compute agreement by hand, re-derive what the scorer prints or query the table with improvised SQL.
- Golden labels are for a human. If the model disagrees and you think golden is wrong, say so in a note; do not edit `tests/golden.json`.
- A `failed` row is a result, not an error to hide, and is never re-run to make the table cleaner.
- The adversarial snapshot is read, never regenerated. If it is missing for a live model, rule 3 is "not run", not "passed".
- This skill reports in chat. Writing `docs/evaluations/README.md`, applying the decision rule (spec §3) or exporting snapshots (`npm run eval:export`) happens only when a human asks.
- Comparing two models means running this skill once per model id and putting the two tables side by side. State the commit hash and whether the working tree was clean, so the comparison traces to a run.
