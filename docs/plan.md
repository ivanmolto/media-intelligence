# Plan — Media Signal Service

Implementation plan. Derived from [`spec.md`](spec.md), which is derived from [`intent.md`](intent.md). Frozen at the commit that adds this file, before the first code commit; departures are rows in [`deviations.md`](deviations.md).

Someone who never saw the conversations should be able to build from this file and the spec alone.

---

## 1. Order of work, and why

| Phase | What                                   | Est.     | PR + cold review |
| ----- | -------------------------------------- | -------- | ----------- |
| 0     | Scaffold, compose, hooks               | 0:30     | —           |
| 1     | Data layer                             | 1:00     | —           |
| 2     | Boolean search                         | 2:00     | yes         |
| 3     | LLM enrichment and the live run        | 1:45     | yes         |
| 4     | API and UI                             | 1:45     | yes         |
| 5     | Scale evidence and budget demo         | 0:45     | —           |
| 6     | README: decisions, cost, reflection    | 0:45     | yes         |
|       | **Build total**                        | **8:30** |             |

The estimates are estimates. Actual time per phase is recorded in the README.

Why this order:

- **Data first** because every later phase reads the schema, and a wrong key on `article_enrichments` is the most expensive thing to change late.
- **Search second** because it carries the largest correctness risk and three Postgres assumptions in the spec that have not been run (§5). If one is wrong, it should surface while there is time to change the design.
- **Enrichment third, with the live run inside it**, not at the end. One live run is not cuttable, so it is done as soon as the worker exists. The mock fixtures are derived from it, so every later phase runs on real recorded output.
- **API and UI fourth** because by then both things it displays exist and are tested.
- **Scale evidence fifth** because everything in it is on the cut list.
- **README last** because its cost and reflection sections report what was measured.

Docs, PR triage, transcript exports and the live cost measurement write-up are budgeted separately from the 8:30, per the intent.

---

## 2. Process

- **PR plus cold review on phases 2, 3, 4 and 6**, as the intent says — where the diff contains judgment. Each of these is a branch and a PR that I merge myself.
- **Phases 0, 1 and 5 are committed to `main` directly**, with no PR and no cold review. I read the diff and the phase's proof before each commit, so the human gate still holds.
- **Plan mode at the start of each phase.** The agent reads the spec and this plan and proposes the phase's steps before it may edit.
- **The cold reviewer** is a fresh-context reviewer that gets the spec, this plan and the diff, and nothing from the build conversation. Its findings are triaged in the PR; they do not approve or block by themselves.
- **Hooks for the deterministic rules** (built in phase 0): no `dangerouslySetInnerHTML`; no `.env` or key patterns in a commit; format and lint after edits; `security-audit` (no `fetch` in the mock provider, no SQL in route files, no string-built SQL).
- **Transcript export** to `docs/ai-transcript/` at the end of each phase, in that phase's PR or final commit.
- **Departures.** If the build departs from the spec or this plan, the same PR or commit adds a row to `deviations.md`.

---

## 3. Phases

Each phase lists the spec requirements it covers, the files it creates, and the proof that it is done. A phase is not done until its proof passes and is recorded: in the PR description for phases 2, 3, 4 and 6, and in the commit message for phases 0, 1 and 5.

### Test database

Integration tests (`*.integration.test.ts`) run against a **separate database, `media_test`, on the compose `db` service**. Not the app database, and not testcontainers.

- `tests/global-setup.ts` (Vitest global setup) creates `media_test` if missing, runs the migrations and the seed against it, and truncates between test files that write.
- A `test` service in `compose.yaml`, behind the `test` profile and built with dev dependencies, runs the suite: `docker compose run --rm test`. A reviewer needs only Docker. On the host, `npm test` does the same against the published `db` port.
- Unit tests (parser, cursor, prompt builder, validator, guardrails, render) touch no database and pass with `db` stopped.
- The one Postgres instance therefore holds three databases: the app's (20 articles, what the UI shows), `media_test`, and the synthetic one for phase 5. Tests never change what the reviewer sees.

Why not the alternatives: tests against the app database would mutate the data the UI shows and make results depend on run order; testcontainers adds a dependency, an image pull per run and a Docker socket requirement inside the `test` container, for isolation a second database already gives.

### Phase 0 — Scaffold, compose, hooks

Covers: S7 (no key needed), S12 (skeleton only).

Files:

- `package.json`, `tsconfig.json`, `next.config.ts`, `.env.example`, `Dockerfile`, `compose.yaml` (`db` with healthcheck, `init`, `web`, and `test` behind a profile)
- `CLAUDE.md` (under a page: commands, the rules the hooks enforce, the verification command)
- `.claude/settings.json` (hooks), `scripts/security-audit.ts`, pre-commit hook
- `app/api/health/route.ts`, `vitest.config.ts`, `tests/global-setup.ts`

Proof: `docker compose up` reaches a healthy `web` that serves `/api/health`; `docker compose run --rm test` runs and creates `media_test`; a commit containing `dangerouslySetInnerHTML` or a `.env` file is blocked.

### Phase 1 — Data layer

Covers: R1–R4, S1, S2, S12. The indexes R5 asks to have explained are created here, each with a one-line comment in the migration; the README explanation itself is phase 6.

Files:

- `db/migrations/001_init.sql` — the three tables and five indexes from spec §1
- `scripts/migrate.ts`, `scripts/seed.ts`
- `lib/db.ts`, `lib/html/strip.ts` (produces `body_text`)
- `lib/articles/filters.ts` (the shared `WHERE` builder), `lib/articles/cursor.ts`, `lib/articles/list.ts`, `lib/articles/aggregate.ts`
- `tests/seed.test.ts`, `tests/cursor.test.ts`, `tests/list.integration.test.ts`, `tests/aggregate.integration.test.ts`

Proof:

- seed twice: the second run inserts 0 rows (S1);
- the generated `tsv` column is accepted by Postgres 16 (first of the three unverified assumptions, §5);
- paging through all 20 articles by cursor returns each exactly once, in order; a cursor with a different `filter_hash` → 400;
- aggregate by week and by month sums to the same total as the list for the same filters;
- article 17 is stored with an empty headline.

### Phase 2 — Boolean search (PR + cold review)

Covers: R6–R8, S3–S6.

Files:

- `lib/search/lexer.ts`, `lib/search/parser.ts` (grammar and limits from spec §2), `lib/search/ast.ts`
- `lib/search/leaves.ts` (the one pre-query that finds empty leaves per config)
- `lib/search/compile.ts` (AST → parameterised fragment, once per config)
- `tests/parser.test.ts`, `tests/search.integration.test.ts`

Steps, in order:

1. A spike test against Postgres for the two remaining unverified assumptions (§5). If either fails, stop and log a deviation before writing the compiler.
   - **Prefix cast:** the expression runs and matches for a plain prefix and for one made of quote and operator characters.
   - **Stop-word prefix, `the*`:** under `english`, `plainto_tsquery` returns an empty tsquery for `the`, and `'' || ':*'` cast to `tsquery` is a syntax error, which would be a 500. The spike confirms that error on the raw expression, then confirms the empty-leaf pre-query reports the prefix leaf as empty so the cast is never reached.
   - **Index usability:** on 20 rows the planner seq-scans whatever the query, so the spike runs `SET LOCAL enable_seqscan = off` inside a transaction and asserts that `EXPLAIN` for the per-config fragment contains a bitmap index scan on the `tsv` GIN index. With seq scans disabled, a fragment the index cannot serve still seq-scans, so this separates "usable" from "not usable". It does not show the planner chooses the index at scale; phase 5 shows that on ~200k rows.
2. Lexer and parser with unit tests for every 400 case in the spec.
3. Empty-leaf pre-query and compiler. The pre-query covers every leaf kind — TERM, PHRASE and PREFIX — and a PREFIX leaf that is empty under a config is removed from that config's fragment before the cast is built, exactly as the spec's empty-leaf rule does for terms.
4. The nine fixed tests from the spec's table, as integration tests against the seeded database.

Proof: all nine fixed tests pass, including the brief's three example queries returning `[1]`, `[5]` and `[]`; `a'b:c&d*`, `the*` and every malformed query return 400 or a result, never 500; `the*` returns `[]` with `warnings: ["the*"]`; `security-audit` finds no tsquery string built in the application.

Checkpoint: before this phase's PR merges, cuts 1 and 4 are decided (§6) and written in the PR.

### Phase 3 — LLM enrichment and the live run (PR + cold review)

Covers: R9, R12, S7–S11, deviation 1. It also produces the measurements R10 and R11 rest on (the score table, the decision, the recorded tokens); the written justification and the 50,000-a-day cost are phase 6.

Files:

- `lib/enrich/taxonomy.ts`, `lib/enrich/schema.ts` (Zod), `lib/enrich/prompt.ts` (versioned `v1`)
- `lib/enrich/provider.ts`, `lib/enrich/mock.ts`, `lib/enrich/openai-compatible.ts`
- `lib/enrich/budget.ts` (reserve, then correct)
- `lib/enrich/call.ts` — the one guarded call: cap input, reserve budget, call the provider with timeout and retry, validate, correct the reservation. Used by the worker and by the live adversarial script, so both run under identical guardrails.
- `lib/enrich/worker.ts`, `scripts/enrich.ts` (`--force`, mock-only) — `npm run enrich`
- `scripts/adversarial-live.ts` — `npm run eval:adversarial`. The adversarial fixtures are not rows in `articles`, so the worker never sees them. This script reads `tests/fixtures/adversarial.json`, sends each fixture through `lib/enrich/call.ts` for `ENRICH_MODEL`, and writes `docs/evaluations/adversarial-<model>.json` (per fixture: input, raw model output, validator verdict). It refuses to run in mock mode and writes nothing to the database except the budget.
- `scripts/export-evaluation.ts` — `npm run eval:export`. Writes the `article_enrichments` rows for `ENRICH_MODEL` to `docs/evaluations/enrichments-<model>.json`. With `--mock-fixtures` it also writes `tests/fixtures/mock-enrichments.json` from the same rows, token counts included.
- `docs/evaluations/README.md` — the score table, the three decision-rule checks per model, and the decision
- `tests/fixtures/adversarial.json`, `tests/adversarial.test.ts`, `tests/guardrails.test.ts`
- `tests/golden.json`, `scripts/score.ts` (about 30 lines)
- `tests/fixtures/mock-enrichments.json`, `docs/evaluations/`

Steps, in order:

1. Schema, prompt builder and validator, with the offline adversarial test.
2. Budget, dedup, timeout and retry, with `guardrails.test.ts` against a fake provider.
3. Worker and `init` wiring, with **hand-written mock fixtures** for the 20 articles in `tests/fixtures/mock-enrichments.json`. The file carries a `provenance` field, here `hand-written`, and token counts marked as estimates (`ceil(chars / 4)`). From this step on the mock path works with no dependency on the live run.
4. **Hand-label `tests/golden.json` before any live output exists**, so the labels are not anchored on a model's answers.
5. **The live run** (§4), with the commands below: both models over the 20 articles, then the adversarial fixtures on both, each exported to `docs/evaluations/`.
6. Score both runs with `npm run score`, read rule 3 from the adversarial snapshots' validator verdicts, apply the spec's decision rule, and record all of it in `docs/evaluations/README.md`.
7. Replace the hand-written fixtures with the primary model's run: `npm run eval:export -- --mock-fixtures`. `provenance` becomes `live`, with the model id and run date, and the token counts become the recorded ones.

**Live run commands.** Run on the host against the compose database, so the snapshots land in the working tree. `OPENROUTER_API_KEY` is read from the gitignored `.env`, never typed on a command line. In file names, `<model>` is the model id with `/` replaced by `-`.

```
docker compose up -d db
npm run migrate && npm run seed

# once per model: anthropic/claude-haiku-5.5, then anthropic/claude-sonnet-5.5
LLM_MODE=live ENRICH_MODEL=<model id> npm run enrich
LLM_MODE=live ENRICH_MODEL=<model id> npm run eval:export
LLM_MODE=live ENRICH_MODEL=<model id> npm run eval:adversarial
ENRICH_MODEL=<model id> npm run score
```

`npm run enrich` and `npm run eval:adversarial` are each run once per model and not repeated; a failed row stays failed and is reported, which is what the decision rule needs to see.

Proof:

- `adversarial.test.ts` and `guardrails.test.ts` pass offline;
- `docker compose up` on a clean checkout with no key ends with 20 `done` rows under `requested_model = 'mock'`;
- `docs/evaluations/` holds `enrichments-<model>.json` and `adversarial-<model>.json` for each model run, produced by the commands above and committed unedited;
- `npm run eval:adversarial` with `LLM_MODE=mock` exits non-zero without calling anything;
- `docs/evaluations/README.md` holds the score table and the decision, with the rule that produced them.

### Phase 4 — API and UI (PR + cold review)

Covers: spec §4 and §5; intent outcomes 1–4.

Files:

- `lib/api/params.ts` (Zod), `lib/api/errors.ts`
- `app/api/articles/route.ts`, `app/api/articles/aggregate/route.ts`
- `app/page.tsx`, `app/trends/page.tsx`, `components/ArticleCard.tsx`, `components/SentimentBadge.tsx`, `components/TrendsChart.tsx` (Recharts)
- `tests/api.integration.test.ts`, `tests/render.test.tsx`

Proof:

- each of the four 400 codes (`invalid_query`, `no_searchable_terms`, `invalid_cursor`, `invalid_param`) is returned by a real test request in `api.integration.test.ts`;
- `internal` (500) is covered by one test that stubs the query function to throw an error whose message contains SQL text, and asserts the response is `{error: {code: "internal", …}}` with none of that text in it. A real request cannot trigger a 500 on demand, so this one is a forced fault;
- `not_found` (404) is not tested because it is dropped: no endpoint takes an id (deviation 2);
- no response in any of these tests contains SQL or provider text;
- `render.test.tsx` asserts articles 6 and 18 produce escaped text and no element, and article 17 shows `(Untitled)`;
- in a browser: the three example queries, `oil and gas` with its warning shown, "Load more", the trends chart with the sentiment filter and the week/month toggle. Screenshots go in the PR.

### Phase 5 — Scale evidence and budget demo

Covers: intent outcomes 6 and 7. Everything here is on the cut list.

Files: `scripts/synthetic.ts`; README fragments with the pasted plans.

Proof: `EXPLAIN (ANALYZE, BUFFERS)` for list, filter, search and aggregate on ~200k synthetic rows, pasted as run; the budget command from spec §3 exits `2`, with the number of articles processed reported as observed.

### Phase 6 — README (PR + cold review)

Covers: R5 (indexes explained), R10 (model choice justified), R11 (cost at 50,000 articles/day); the five required README sections; intent outcome 8.

Files: `README.md`, final `docs/ai-transcript/` export.

Content: Plan (a summary of this file, linking to it and to its commit); Architecture & Decisions; LLM Cost Analysis (measured tokens × dated list price, × 50,000; a batch-price column from §4, labelled as a projection from the same measured tokens; the hypothetical column labelled); Security & Responsibility (the spec §6 table with evidence, the adversarial result as observed, the CSP line); Reflection (from the deviations log and the transcript, including where the AI was wrong).

Proof: every number in the README traces to a file in the repo or is written as a formula; the cold `docker compose up` time is measured on a clean checkout; the cold reviewer checks the README against the code, not against this plan.

---

## 4. Models

Resolved here, as the spec defers. Prices are list prices from OpenRouter's public models endpoint (`https://openrouter.ai/api/v1/models`), retrieved 2026-11-15.

| Tier  | Model                         | Input, per 1M tokens | Output, per 1M tokens | Structured outputs |
| ----- | ----------------------------- | -------------------- | --------------------- | ------------------ |
| Small | `anthropic/claude-haiku-5.5`  | $0.10                | $0.50                 | listed as supported |
| Mid   | `anthropic/claude-sonnet-5.5` | $2.00                | $10.00                | listed as supported |

- Both meet the spec's first two criteria from the endpoint's own data. The third, Arabic and Chinese input with English output, is not assumed: articles 8 and 9 in the live run test it.
- Same vendor, 20× apart on price, so the comparison isolates what the extra spend buys.
- Prices are re-read on the day of the live run. The README cites that day's price; if it differs from this table, the README says so.
- No quality or latency is claimed for either model here. Those come from the run.

**Batch variants.** The same endpoint lists a `:batch` variant of each model at half the list price, also listed as supporting structured outputs:

| Model                               | Input, per 1M tokens | Output, per 1M tokens |
| ----------------------------------- | -------------------- | --------------------- |
| `anthropic/claude-haiku-5.5:batch`  | $0.05                | $0.25                 |
| `anthropic/claude-sonnet-5.5:batch` | $1.00                | $5.00                 |

Enrichment runs off the request path, so nothing waits on a single response and batch pricing is a real option at 50,000 articles a day. It goes in the README's cost section (phase 6) as its own column: the tokens measured in the live run × the batch list price. It is a projection, labelled as one. The batch variants are not called in this project, so their turnaround time and request shape are stated as untested, and the live call budget below is unchanged.

Live call budget: 2 models × 20 articles, plus 2 models × the adversarial fixtures (deviation 1). Nothing else is called live.

---

## 5. Risks

| Risk                                                                                                   | Where it surfaces | Response                                                                                                    |
| ------------------------------------------------------------------------------------------------------ | ----------------- | ----------------------------------------------------------------------------------------------------------- |
| Three Postgres behaviours in the spec were written from knowledge, not run: the generated `tsv` column with `CASE` outside `to_tsvector`; the prefix cast `(plainto_tsquery(…)::text ‖ ':*')::tsquery`; the GIN index being used by the per-config fragment. | Phase 1 proof; phase 2 step 1 | Test each before building on it; the index check runs with `enable_seqscan = off`, because 20 rows always seq-scan. A failure is a deviation row and a design change, not a workaround.        |
| A model fails structured outputs through OpenRouter despite being listed.                              | Phase 3 step 5    | The decision rule already disqualifies it. If both fail, the spec's "finding, not a choice" rule applies.   |
| The mock path — the default, and the only one most reviewers run — depends on the live run for its fixtures. If the live run is blocked (no key, OpenRouter unavailable, both models failing the schema), `docker compose up` would have nothing to show. | Phase 3 steps 3 and 5 | The mock path is built first on hand-written fixtures (step 3) and never waits on the live run. Step 7 replaces them. If the live run cannot be completed, the hand-written fixtures ship, the `provenance` field and the README say so, and it is a deviation row against spec S11. |
| The live run costs more calls than planned because of retries.                                         | Phase 3 step 5    | Retries are capped at 1 and the daily budget is set for the run. Actual calls are reported.                 |
| The Next.js image build is slow and the cold-start claim is wrong.                                     | Phase 0, phase 6  | No time is claimed until measured on a clean checkout.                                                      |
| Phases 2 and 3 overrun and squeeze the UI.                                                             | End of each phase | The cut order, §6. Both pages are not cuttable, so cuts come from elsewhere.                                |

---

## 6. Cut order

**Checkpoint: end of phase 2.** Cuts 1 and 4 are decided there, and only there. Both shape phase 3 (how many models run live, and whether the scorer is built), so they are settled before it starts, from the time used through phase 2. The decision and the time used are recorded in the phase 2 PR, and neither cut is reopened mid-phase 3.

The other cuts (2, 3, 5, 6) are checked at the end of every phase: if the build is more than 30 minutes behind the cumulative estimate, the next uncut one is taken, in this order.

| #   | Cut                               | Falls back to                                             | Deviation row needed                 |
| --- | --------------------------------- | --------------------------------------------------------- | ------------------------------------ |
| 1   | Two-model comparison              | Single model (the small one)                              | yes — spec S10 and §3                |
| 2   | Chart                             | Table                                                     | yes — spec §5                        |
| 3   | Synthetic rows + `EXPLAIN ANALYZE` | README states "indexes designed, unmeasured"              | yes — removes intent outcome 7       |
| 4   | Golden-set scorer                 | Manual review of the 20, recorded in a table              | yes — spec §7                        |
| 5   | Week/month toggle                 | Week only                                                 | yes — spec §5                        |
| 6   | `--force` budget demo             | Budget mechanism tested in unit tests; demo documented    | yes — removes intent outcome 6       |

Already cut before the plan: a Content-Security-Policy (one README line).

**Not cuttable:**

- the parser tests and the three fixed results;
- the adversarial fixture;
- the five README sections;
- the transcript;
- both pages;
- one live run.

---

## 7. Done

The work is done when a reviewer can do each of the intent's eight outcomes, or a deviation row says why one changed.

| Intent outcome                                   | Delivered by |
| ------------------------------------------------ | ------------ |
| 1 Boolean search, expected results               | Phase 2, 4   |
| 2 Summary, sentiment, tags without a key         | Phase 3, 4   |
| 3 Counts per week or month, filterable           | Phase 1, 4   |
| 4 Articles 6 and 18 inert, 17 `(Untitled)`       | Phase 4      |
| 5 Adversarial fixture test                       | Phase 3      |
| 6 Budget stop                                    | Phase 3, 5   |
| 7 Cursor paging and `EXPLAIN` on synthetic rows  | Phase 1, 5   |
| 8 README with measured cost and backed reflection | Phase 6      |
