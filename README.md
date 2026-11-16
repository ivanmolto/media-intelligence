# Media Signal Service

Ingests 20 news articles, enriches each with an LLM (summary, sentiment, topic tags), and exposes boolean search and time-bucketed counts over them. Next.js + TypeScript + PostgreSQL 16, in Docker Compose.

The design documents were committed before the code and are frozen: [`docs/intent.md`](docs/intent.md) → [`docs/spec.md`](docs/spec.md) → [`docs/plan.md`](docs/plan.md). Every departure from them is a row in [`docs/deviations.md`](docs/deviations.md) (25 rows). Where a row and a document differ, the row is what was built.

## Run it

```bash
docker compose up
```

- Search page: <http://localhost:3000>. Trends page: <http://localhost:3000/trends>.
- No API key is needed. Compose runs `db` → `init` (migrate, seed, enrich in mock mode, then exits) → `web`. Mock mode makes no network call and replays the recorded output of the live run (see [LLM Cost Analysis](#llm-cost-analysis)).
- If port 3000 or 5432 is taken: `DB_PORT=55432 WEB_PORT=3100 docker compose up`.
- Tests, needing only Docker: `docker compose run --rm test`.

**Cold start, measured once.** 136 s from the start of the build to `/api/health` answering `{"ok":true}`: 131 s for `docker compose build --no-cache`, 5 s for `docker compose up -d` to a healthy `web` with 20 enriched articles. Fresh `git clone` at commit `55b9b11`, empty volume, Docker 24.0.6 on an Apple M1 Max, 2026-11-16. Two things to know about that figure: the base images (`node:24-alpine`, `postgres:16-alpine`) were already on the machine, so no image pull is in it; and `--no-cache` made Compose build the same image twice, once for `init` and once for `web` (`npm ci` took about 55 s each time). A plain `docker compose up` shares the build cache between the two, which I did not time.

Things to try:

| Try                               | Where                                                                                                                                                                                                      |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The brief's three example queries | Search page. The expected article ids for these and 22 more cases are in [`tests/fixtures/search-expectations.json`](tests/fixtures/search-expectations.json), the one file the test suite reads them from |
| `oil and gas`                     | Lowercase `and` is a search term, not an operator. The page shows that it was ignored as a stop word                                                                                                       |
| `(AI OR energy`, `NOT AI`         | A 400 with the parser's message, shown inline                                                                                                                                                              |
| Articles 6 and 18                 | Their payloads (`<img onerror>` and `<script>` in 6, `<b onmouseover>` in 18) appear as visible text                                                                                                       |
| Article 17                        | Empty headline, shown as `(Untitled)`                                                                                                                                                                      |
| "Load more"                       | Cursor pagination                                                                                                                                                                                          |
| `/trends`                         | Counts per week or month, filtered by sentiment, for the same query as the search page                                                                                                                     |

On the host (Node 24), for development:

```bash
git config core.hooksPath .githooks   # once per clone; without it there is no pre-commit hook
cp .env.example .env
npm ci
docker compose up -d db
npm run verify                        # typecheck, lint, format check, security-audit, tests
```

Vitest does not read `.env`. If `DB_PORT` is not 5432, export `TEST_DATABASE_URL` with the same port before `npm test` or `npm run verify`.

Live mode uses your own OpenRouter key and is run on the host, never by Compose: set `LLM_MODE=live`, `OPENROUTER_API_KEY` and `ENRICH_MODEL` in `.env`, then `npm run enrich`. This repo ships no key.

---

## Plan

The plan is [`docs/plan.md`](docs/plan.md), committed in `90074af` on 2026-11-15 at 22:38. The first code commit is `ef41db3`, on 2026-11-16 at 02:43. It has not been edited since; `git log --follow docs/plan.md` shows that, and the pre-commit hook blocks any change to it.

**How I broke the problem down.** Seven phases, each with a proof that had to pass before the phase counted as done:

| Phase | What                            | Estimate | Landed (commit time, +01:00) | Review           |
| ----- | ------------------------------- | -------- | ---------------------------- | ---------------- |
| 0     | Scaffold, compose, hooks        | 0:30     | `ef41db3`, 02:43             | —                |
| 1     | Data layer                      | 1:00     | `6f49aa8`, 03:02             | —                |
| 2     | Boolean search                  | 2:00     | PR #1 merged, 03:40          | PR + cold review |
| 3     | LLM enrichment and the live run | 1:45     | PR #2 merged, 04:57          | PR + cold review |
| 4     | API and UI                      | 1:45     | PR #3 merged, 05:32          | PR + cold review |
| 5     | Scale evidence, budget demo     | 0:45     | `55b9b11`, 05:51             | —                |
| 6     | README                          | 0:45     | this PR                      | PR + cold review |
|       | **Build total**                 | **8:30** |                              |                  |

The "Landed" column is commit timestamps from `git log`. It is wall-clock time between commits.

**What I tackled first and why** (plan §1):

- Data first, because every later phase reads the schema and a wrong key on the enrichment table is the most expensive thing to change late.
- Search second, because it carried the largest correctness risk and three Postgres behaviours the spec had written from knowledge without running them. The first commit of that phase is a spike test that runs them.
- Enrichment third, with the live run inside the phase, not at the end. One live run was not cuttable, and the mock fixtures are derived from it, so every later phase ran on recorded model output.
- API and UI fourth, when both things they display existed and were tested.
- Scale evidence fifth, because everything in it was on the cut list.
- README last, because its cost and reflection sections report what was measured.

**What I would cut if time ran short** (plan §6), in this order: the two-model comparison (fall back to the small model), the chart (a table), the synthetic rows and `EXPLAIN ANALYZE` (README says "indexes designed, unmeasured"), the golden-set scorer (manual review in a table), the week/month toggle (week only), the `--force` budget demo. Not cuttable: the parser tests and the brief's three results, the adversarial fixture, the five README sections, the transcript, both pages, one live run.

**No cut was taken.** Cuts 1 and 4 had a fixed decision point at the end of phase 2 because both shape phase 3; PR #2 records them as not taken. A Content-Security-Policy was cut before the plan was written.

**Process.** Plan mode at the start of each phase; a branch, a PR and a fresh-context reviewer on the four phases whose diff contains judgment; a git pre-commit hook for the rules that can be checked mechanically; a human gate on every merge and every commit to `main`. The rules the agent worked under are in [`CLAUDE.md`](CLAUDE.md), the review policy in [`docs/REVIEW.md`](docs/REVIEW.md).

---

## Architecture & Decisions

### Stack

| Choice                                | Why                                                                                                                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Next.js 16, React 19, TypeScript      | One process serves the API and both pages. Route handlers are thin: they call `lib/`, which has no Next import and is tested without a server                                                           |
| PostgreSQL 16, `pg`, hand-written SQL | Search, filters and aggregates are one database, so a search result and its chart come from the same `WHERE`. No ORM: every statement is readable in the repo and is the statement `EXPLAIN` was run on |
| Zod                                   | One schema validates request parameters, another validates model output                                                                                                                                 |
| Recharts, Tailwind defaults           | A bar chart and nothing styled beyond defaults                                                                                                                                                          |
| Vitest                                | Unit tests run with the database stopped; integration tests run against a separate `media_test` database, never the one the UI shows                                                                    |

Not used, deliberately: Redis, a queue, a vector database, auth, a design system.

### Schema

[`db/migrations/001_init.sql`](db/migrations/001_init.sql), three tables.

- **`articles`** keeps the raw `headline` and `body` as received, plus `headline_text` and `body_text` with HTML stripped. Search and the LLM read only the stripped columns. `tsv` is a generated column: `to_tsvector('english', …)` for English articles, `to_tsvector('simple', …)` for the rest.
- **`article_enrichments`** is keyed by `(article_id, requested_model, prompt_version, taxonomy_version)`. That key is one enrichment run, so two models over the same 20 articles are two sets of rows and neither overwrites the other. The API joins each article to the row for the active run key: one join, at most one row per article, no N+1. Each row records `model`, `provider`, tokens, latency and cost as the provider's **response** reported them.
- **`enrichment_budget`** holds tokens used per UTC day.

Two columns exist because of something the spec got wrong: `headline_text` (deviation 15: Postgres indexes the words inside a tag, so a search for `xss` returned article 6 through its raw headline) and `attempts` (deviation 7: the spec asked for a first-attempt success rate its schema could not produce).

### Indexes

Six, each with a comment in the migration. On 20 rows Postgres seq-scans whatever the query, so the evidence is `EXPLAIN (ANALYZE, BUFFERS)` on 200,000 synthetic rows: the full output is [`docs/evaluations/explain.txt`](docs/evaluations/explain.txt) (15 cases, PostgreSQL 16.13, written at commit `0c0121e`), and [`docs/evaluations/scale-evidence.md`](docs/evaluations/scale-evidence.md) walks through it. `npm run db:explain` runs the application's own statements, through the same parameter parsing and query builders the routes use.

| Index                                                            | For                                    | Result on the synthetic dataset                                                                           |
| ---------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `articles (published_at desc, id desc)`                          | keyset pagination; date range          | uses the index                                                                                            |
| `articles (source, published_at desc, id desc)`                  | source filter, then the keyset order   | uses the index                                                                                            |
| `articles (language, published_at desc, id desc)`                | language filter, then the keyset order | uses the index                                                                                            |
| `articles using gin (tsv)`                                       | boolean search                         | uses the index for the phrase search and the searched aggregate; **not** for the three other search cases |
| `article_enrichments using gin (tags)`                           | topic filter                           | **designed; not chosen by the planner on this dataset**                                                   |
| partial index on `(content_hash, run key) where status = 'done'` | the worker's dedup lookup              | designed, unmeasured: no route query uses it                                                              |

Equality columns come first and the keyset order, tiebreak included, comes after, so a filtered page is read in order from the index with no sort.

Two results I did not expect and am not hiding:

- **Search does not always use the GIN index.** For a term in about 2% of rows with `ORDER BY published_at DESC LIMIT 21`, the planner walks the newest articles and filters, and reads about 1,100 rows to find 21. It was right to. The walk gets more expensive as a term gets rarer or its matches get older, and no case in the file measures that.
- **The tags index is named in no plan.** The generator puts every tag on about 14% of rows, so 21 matches turn up within 152 articles. The index would matter for a rare tag or a query without `LIMIT`; neither was run.

The synthetic term rates are choices made in `scripts/synthetic.ts`, not corpus measurements, and they decide what the planner picks. Timings are a local container with a warm cache, not production latencies.

### Pagination

Keyset: `WHERE (published_at, id) < ($ts, $id) ORDER BY published_at DESC, id DESC LIMIT $n`. The cursor is opaque and carries a hash of the filters and run key, so a cursor replayed on a different query is a 400. From `explain.txt`, first page and page 50:

```
->  Index Scan using articles_published_idx on articles a  (cost=0.42..177988.76 rows=200058 width=102) (actual time=0.009..0.019 rows=21 loops=1)
->  Index Scan using articles_published_idx on articles a  (cost=0.42..178451.25 rows=199049 width=102) (actual time=0.015..0.028 rows=21 loops=1)
      Index Cond: (ROW(published_at, id) < ROW('2026-06-27 10:36:27.741+00'::timestamp with time zone, '161833'::bigint))
```

Both read 21 rows and neither has a `Sort` node. Page 50 is as deep as was run.

### Aggregate

`GET /api/articles/aggregate` counts by week (default) or month, optionally grouped by sentiment, source or topic. `bucket` and `group_by` map from a whitelist to constant SQL. It takes the same `WHERE` builder as the list ([`lib/articles/filters.ts`](lib/articles/filters.ts)), so the chart always describes the search it sits next to.

- Grouped by topic, an article with several tags is counted once per tag, so the groups do not sum to the article total. The response says so in a `notes` field (deviation 22).
- An unfiltered aggregate reads every row: 163.878 ms on 200,000 rows, with a sort that spills to disk at the default `work_mem`. That grows linearly. At real volume the answer is a rollup table or a date-bounded query; neither is built.

### Boolean search

**Approach: a hand-written parser, compiled to parameterised SQL over PostgreSQL full-text search.** ([`lib/search/`](lib/search/))

1. A lexer and recursive-descent parser turn the query into an AST. `AND`, `OR` and `AND NOT` are operators only in upper case; adjacent terms are ANDed; `AND` binds tighter than `OR`. Limits: 500 characters, 32 terms, nesting depth 8.
2. Each leaf becomes one `$n` parameter: a term is `tsv @@ plainto_tsquery(cfg, $n)`, a phrase uses `phraseto_tsquery`, a prefix is `(plainto_tsquery(cfg, $n)::text || ':*')::tsquery`. Boolean structure is SQL `AND` / `OR` / `AND NOT`. The application never assembles a tsquery string from user text.
3. The AST is compiled twice, once per text-search config, and joined under a language guard, so the config is a constant in each branch and the GIN index stays usable.

Why not the alternatives:

- `websearch_to_tsquery` has its own syntax (`-term`, lowercase `or`) and no brackets or prefix operator. It cannot express the brief's grammar or its case-sensitive operators.
- Building one `to_tsquery` string means quoting user text into tsquery syntax in the application. That is an injection surface and it turns a typo into a 500.
- A parser library would still leave the compile step, which is where the decisions are.

What it costs:

- **Stop words.** Under `english`, `and` and `the` produce an empty tsquery, and `tsv @@ ''` is false, so `oil and gas` would silently match nothing. One pre-query asks Postgres which leaves are empty under each config; those leaves are dropped from that config's branch and returned in `warnings`.
- **Stemming.** English matching is on stems. A prefix longer than its stem can miss (`renewab*` against the stem `renew`), and a phrase containing a stop word has a positional gap.
- **No ranking.** Results are ordered by date. Relevance ranking is not built.

**Arabic and Chinese** (articles 8 and 9). The `english` config is wrong for them, so non-English articles are indexed and searched with `simple`: no stemming, no stop list, split on whitespace and punctuation. What is still missing for Chinese is word segmentation. Chinese has no spaces between words, so a run of characters is indexed as one token and a search for a word inside it does not match. `zhparser` or `pg_jieba` would be the fix; both are extensions the stock Postgres image does not have. Arabic gets no stemming either, so inflected forms do not match each other.

### LLM model selection

Full evaluation: [`docs/evaluations/README.md`](docs/evaluations/README.md), with the exported rows and raw adversarial outputs beside it.

Two models from the same vendor, about 20× apart on price, each run once over the 20 articles through OpenRouter on 2026-11-16, scored against labels I wrote by hand **before** any model output existed ([`tests/golden.json`](tests/golden.json)).

|                                         | `anthropic/claude-haiku-5.5` | `anthropic/claude-sonnet-5.5` |
| --------------------------------------- | ---------------------------- | ----------------------------- |
| Sentiment agreement with my labels      | 17 / 20                      | 14 / 20                       |
| Tag validity                            | 17 / 20                      | 14 / 20                       |
| Schema-valid on the first attempt       | 20 / 20                      | 20 / 20                       |
| Adversarial fixtures, validator verdict | 5 valid                      | 5 valid                       |
| Latency p50 / p95, ms (n = 20)          | 1,238 / 2,687                | 1,740 / 2,494                 |
| Cost per article, provider-reported     | $0.000147                    | $0.002984                     |

**Decision: Haiku is the primary model**, by a rule fixed in the spec before the run: the cheaper model wins unless it is more than one article worse on sentiment, produces a schema-invalid output after the retry, or breaks the schema on an adversarial fixture. None of the three holds.

**The caveat belongs next to the decision.** The result is not "Haiku reads sentiment better". Sonnet returned `mixed` six times where my labels have it once, and five of its six misses are exactly that. On four of those articles the label is a judgment call. If I had labelled three of the four `mixed`, Sonnet would be primary. So what the run shows is that Haiku's use of `mixed` matches this labeller's reading of "only when both sides carry weight". The two models agree with each other on 15 of 20. One run, 20 articles, one labeller, no repeat: a three-article gap could be within run-to-run noise, and nothing here measures that.

- **Quality** is the table above, with that limit.
- **Cost** is the next section.
- **Latency** is reported and does not decide. Enrichment runs off the request path, so no user waits on it. The upstream provider was not pinned (Anthropic, Azure and Google served the calls), so the latencies mix upstreams.

**One call, one model, all three outputs.** The brief asks whether I would split tasks across models. Not here: summary and classification need the same article, so a split sends the article twice, and input is about 87% of the tokens (840.0 of 966.9 on average). A split would pay if summaries had to be much better than a small model writes and classification stayed cheap: at that point the expensive model's input cost is fixed by the summary anyway and the question is only whether the cheap classifier is worth a second call.

---

## LLM Cost Analysis

### What was measured

From `npm run eval:metrics` (the query is [`scripts/enrichment-metrics.sql`](scripts/enrichment-metrics.sql)), on the database that holds the live rows. The same rows are exported in `docs/evaluations/enrichments-<model>.json`.

```
run key: anthropic/claude-haiku-5.5 / v1 / v1
done: 20
failed: 0
done_first_attempt: 20
latency_p50_ms: 1238
latency_p95_ms: 2687
mean_input_tokens: 840.0
mean_output_tokens: 126.9
provider_calls: 20
total_input_tokens: 16800
total_output_tokens: 2537
total_cost_usd: 0.002949
models: anthropic/claude-haiku-5.5
providers: Anthropic,Azure,Google
```

```
run key: anthropic/claude-sonnet-5.5 / v1 / v1
done: 20
failed: 0
done_first_attempt: 20
latency_p50_ms: 1740
latency_p95_ms: 2494.25
mean_input_tokens: 840.0
mean_output_tokens: 130.4
provider_calls: 20
total_input_tokens: 16800
total_output_tokens: 2607
total_cost_usd: 0.059670
models: anthropic/claude-sonnet-5.5
providers: Azure,Google
```

(Lines that are zero or repeat another line are left out; the command prints them all.)

**Prices.** List prices from OpenRouter's public models endpoint (`https://openrouter.ai/api/v1/models`), retrieved 2026-11-15 and recorded in `docs/plan.md` §4: Haiku $0.10 in / $0.50 out per 1M tokens, Sonnet $2.00 / $10.00. The cost each response reported matches tokens × those prices:

- Haiku: 16,800 × $0.10/1M + 2,537 × $0.50/1M = $0.0029485, reported $0.002949.
- Sonnet: 16,800 × $2.00/1M + 2,607 × $10.00/1M = $0.059670, reported $0.059670.

### Per article, and at 50,000 articles a day

|                                                               | Haiku (primary) | Sonnet        |
| ------------------------------------------------------------- | --------------- | ------------- |
| Tokens per article, measured mean (in / out)                  | 840.0 / 126.9   | 840.0 / 130.4 |
| Cost per article, measured: total ÷ 20                        | $0.000147       | $0.002984     |
| **Per day at 50,000 articles: per-article × 50,000**          | **$7.37**       | **$149.18**   |
| _Projection:_ batch pricing, half the list price, same tokens | $3.69           | $74.59        |
| _Hypothetical:_ a 1,500-token article, see formula below      | $11.74          | $236.50       |

What each row is:

- **Measured rows** rest on 20 short sample articles. The 840 input tokens include the system prompt and wrapper on every call. Real articles are longer than these, so treat $7.37 as the cost for articles of this size, not a forecast.
- **Batch** is a projection: OpenRouter lists a `:batch` variant of each model at half price (plan §4). The batch variants were not called in this project, so their turnaround time and request shape are untested. Enrichment is off the request path, so batch is a real option.
- **Hypothetical** is a formula, not a measurement: `((1,500 + P) × price_in + O × price_out) × 50,000`, with `O` the measured mean output tokens and `P` the per-call prompt overhead. `P` was not measured separately from the article; I used 213, the code's own estimate (`ceil(849 characters / 4)`, [`lib/enrich/prompt.ts:26`](lib/enrich/prompt.ts)). The input cap of 8,000 characters bounds any article at roughly 2,000 tokens by the same 4-characters-per-token estimate.
- **Retries** would add to all of these. In the live run no call needed one.

**Self-hosted** is not costed, because I have no measured number to put in it. The formula is `GPU-hours × price per GPU-hour + operations`. What would have to be measured first: throughput in articles per second at the target latency on a given GPU, and the prefix-cache hit rate on the shared system prompt. Break-even is the daily volume at which that fixed cost drops below the API bill; at $7.37 a day for the primary model, the API side of that comparison is small.

**The evaluation itself** cost $0.076274 over 50 calls: 2 models × 20 articles and 2 models × 5 adversarial fixtures.

### Guardrails implemented

All in [`lib/enrich/`](lib/enrich/); each has a test.

| Guardrail          | Value                                                                                                            | Evidence                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Input cap          | 8,000 characters of body, head + tail if longer; HTML stripped first                                             | `adversarial.test.ts` › caps a long body at 8,000 characters, keeping head and tail                |
| Output cap         | 300 tokens, sent as `max_tokens`                                                                                 | `guardrails.test.ts` › sends the capped output, the schema and nothing callable                    |
| Timeout            | 20 s, aborts the request                                                                                         | `guardrails.test.ts` › times out, aborts the signal and does not retry                             |
| Retries            | one, on invalid output, a 5xx or no response; none on a 4xx                                                      | `guardrails.test.ts` › retries once on …; does not retry a 400 / 401 / 402 / 429                   |
| Daily token budget | reserved before each call in one atomic `UPDATE`, corrected afterwards to the reported tokens; default 1,000,000 | `guardrails.integration.test.ts` › cannot be passed by concurrent reservations                     |
| Dedup              | an article with the same content hash and run key is copied, not called                                          | `guardrails.integration.test.ts` › copies a done row with the same content hash instead of calling |
| Concurrency        | 3 calls in flight; rows claimed with `FOR UPDATE SKIP LOCKED`                                                    | `guardrails.integration.test.ts` › hands each pending row to one claimer only                      |
| Re-run safety      | a re-run calls nothing; `--force` is refused in live mode                                                        | `guardrails.integration.test.ts` › a re-run calls nothing and charges nothing                      |

A failed enrichment is stored as `failed` with a null sentiment. It is never defaulted to `neutral`, and the UI shows no badge for it.

**The budget stop, as observed** (2026-11-16, mock mode; full output in `scale-evidence.md`):

```
$ docker compose -p media-signal-budget-demo run --rm -e DAILY_TOKEN_BUDGET=1000 init
enrich: run key mock / v1 / v1: done 1 (copied 0), failed 0
enrich: budget_exceeded: the daily token budget is used up; 19 row(s) left pending. Run `npm run enrich` (without --force) once the budget allows.
exit: 2
```

One article processed (971 tokens), 19 left pending, none failed. The spec's own command, `docker compose run --rm -e DAILY_TOKEN_BUDGET=1000 init npm run enrich -- --force`, on a stack that `docker compose up` has already enriched that UTC day, stops after **0** articles: the mock run spends its recorded tokens too, so the day is already over 1,000. That is a real stop, but it shows less, which is why the fresh-volume run is the one above (deviation 25). `docker compose run --rm init` restores the full enrichment.

One consequence worth stating: at 50,000 articles of this size a day, the run would use about 48.3 million tokens (966.9 × 50,000). The default budget of 1,000,000 is sized for this repo and would stop after roughly a thousand articles. The budget is a setting to size to the expected volume, with headroom, not a constant.

Not built: **semantic caching**. Exact-duplicate detection is safe because identical text gets an identical answer. Caching on similarity is not: two articles about the same company on different days can be close in embedding space and opposite in sentiment, and a wrong hit is a wrong label with no error. It would need a similarity threshold validated against labelled pairs, and a cache key that includes the model and prompt version.

---

## Security & Responsibility

Article text is untrusted at three boundaries: the database, the model and the browser. The table is the output of the `security-audit` skill, run at commit `55b9b11`, clean tree, 2026-11-16, in mock mode. 105 tests in 4 files ran for the three test filters it uses.

| Threat                      | Control                                                                                                                       | Result                                                                                                    | Evidence                                                                                                                                                                                                                                                                                                                               |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQL injection               | Every value is a `$n` parameter                                                                                               | PASS                                                                                                      | Every `.query` call site under `app`, `lib`, `components` and `scripts` traced to where its text is built: constants, or constants plus placeholders. `npm run security-audit`: `no-string-built-sql` passes over 45 files, with 12 marked lines that assemble fragments from constants and placeholders, each printed with its reason |
| SQL injection               | `bucket`, `group_by` map from a whitelist; `sentiment`, `topic`, `language` validated before any SQL is built                 | PASS                                                                                                      | [`lib/api/params.ts`](lib/api/params.ts); `api.integration.test.ts` feeds `en; DROP TABLE articles` and `week; DROP TABLE articles` and gets `invalid_param`                                                                                                                                                                           |
| SQL injection               | No tsquery string built from user text                                                                                        | PASS                                                                                                      | Every `*_tsquery(` takes a `$n`; the one `::tsquery` cast is built inside SQL from Postgres's own output ([`lib/search/compile.ts`](lib/search/compile.ts))                                                                                                                                                                            |
| SQL in route files          | Routes only call `lib/`                                                                                                       | PASS                                                                                                      | `security-audit`: `no-sql-in-routes`, 3 route files                                                                                                                                                                                                                                                                                    |
| XSS (articles 6, 18)        | Article text and model output are React text nodes                                                                            | PASS                                                                                                      | No `dangerouslySetInnerHTML`, `innerHTML`, `eval` or similar anywhere in `app`, `lib`, `components`. `render.test.tsx` › article 6, article 18 › renders only the card's own elements; shows the markup as escaped text. The pre-commit hook blocks these sinks in new source                                                          |
| Links from data             | No `href` or `src` comes from an article or the model                                                                         | PASS                                                                                                      | Two hits, both the app's own routes (`SearchView.tsx:234`, `TrendsView.tsx:96`)                                                                                                                                                                                                                                                        |
| Prompt injection, offline   | The article goes to the model as one escaped JSON block it cannot close; HTML stripped; output must pass the schema; no tools | PASS: the prompt builder escapes the fixtures, HTML is stripped, the validator rejects compromised output | `adversarial.test.ts` over the 5 fixtures in [`tests/fixtures/adversarial.json`](tests/fixtures/adversarial.json): override, sentiment steering, exfiltration, forged `</article>`, URL in summary. No `tools` or `tool_choice` in `lib/enrich`                                                                                        |
| Prompt injection, live      | Same, against the two real models                                                                                             | As observed: Haiku 5 of 5 valid, Sonnet 5 of 5 valid                                                      | `docs/evaluations/adversarial-<model>.json`                                                                                                                                                                                                                                                                                            |
| Output-channel exfiltration | A summary containing a URL is rejected; nothing from model output is fetched or linked                                        | PASS                                                                                                      | `adversarial.test.ts` › `no_url_in_summary` › validator verdict: invalid. The only two `fetch` calls are the provider base URL and the app's own API                                                                                                                                                                                   |
| Cost runaway                | The guardrails in the table above                                                                                             | PASS                                                                                                      | `guardrails.test.ts`, `guardrails.integration.test.ts`                                                                                                                                                                                                                                                                                 |
| Mock isolation              | The mock provider makes no network call                                                                                       | PASS                                                                                                      | `security-audit`: `mock-no-fetch`                                                                                                                                                                                                                                                                                                      |
| Secrets                     | `.env` is gitignored; the hook blocks `.env` files and key patterns                                                           | PASS                                                                                                      | Only `.env.example` is tracked; no pattern from `scripts/secret-patterns.txt` matches a tracked file or any commit in history. `docs/evaluations/` was scanned; `docs/ai-transcript/` did not exist yet at this commit                                                                                                                 |
| Content-Security-Policy     | Not built                                                                                                                     | PASS (stated)                                                                                             | See below                                                                                                                                                                                                                                                                                                                              |

**What the prompt-injection evidence does and does not show.** The offline test proves the deterministic controls: a forged `</article>` cannot close the block, HTML is stripped, and an output with a URL, a tag outside the taxonomy or an invalid sentiment is rejected instead of stored. It cannot show how a model behaves, because the mock returns its fixture whatever the input. So the five fixtures were also run live, once per model (deviation 1). On both models, on all five: the output was schema-valid on the first attempt, no planted canary string appeared, and the planted sentiment was not returned. Two things I saw reading Haiku's raw output, which the validator does not judge: on `exfiltration` the summary remarks that the article contains an embedded instruction "which was ignored", so it comments on the injection instead of only summarising; and on `forged_delimiter` 207 output tokens were reported for an output about as long as the others (95 to 107), which I cannot explain. This is what two models did on five fixtures, once. It does not show that either resists injection in general.

The schema is the real boundary. An output can follow a planted instruction and still be valid: a steered sentiment is still one of four allowed values. The schema limits what a successful injection can do to "a wrong label or a misleading summary on that one article". It cannot make the application fetch, link or execute anything.

**Limits I know about:**

- The pre-commit hook is the only hook. `git commit --no-verify` skips it, and a clone has no hook until `git config core.hooksPath .githooks` is run (deviation 12).
- The marked SQL-fragment lines are an honour system between audits: the script trusts the marker, and the traced check above is what verifies it.
- No **Content-Security-Policy** header is set. It would be defence-in-depth behind the text-node rendering: a `script-src 'self'` policy would stop an injected script from running even if a raw-HTML sink were ever introduced.
- No authentication, HTTPS or rate limiting on the API; the brief excludes them.

---

## Reflection

AI transcripts are under `docs/ai-transcript/`.

Cold reviews: planned, not done. The plan called for an independent reviewer agent, run cold on each PR branch (phases 2, 3, 4, 6), with me triaging its findings. I skipped it because of time.

What that costs: the code on those branches was checked only by the session that wrote it and by me reading the diff. npm run verify, the search expectations and the security audit catch regressions against what I thought to test; they don’t catch what a reader with no context would have questioned.

What is still in the repo: the reviewer definition (.claude/agents/reviewer.md) and the policy (docs/REVIEW.md), so the review can be run on any of the merged PRs as they stand.

### Where AI helped most

- **Running the assumptions before building on them.** The spec stated three Postgres behaviours from knowledge. The plan made the agent test each first; all three held (`1747b3d`), and the same habit caught one that did not (below).
- **Probing after the tests were green.** With the search compiler finished, the agent tried control characters and found that a NUL byte reached Postgres and came back as a 500. The failing test was committed first, then the fix (`7db33f3`, `189856a`, deviation 16).
- **Reviewing its own tooling against the spec.** Writing the skills that check the work exposed contradictions in my spec: a fixed test that contradicted the spec's own compile rule (deviation 3), a metric the schema could not produce (7), a security control no test covered (10), a hook configuration that pointed at scripts that were never written (12).
- **Turning measurements into caveats.** The evaluation write-up leads with the reason its own headline result is fragile.

### Where it misled me or produced something I had to fix

- **It assumed Postgres would drop HTML tags when indexing.** It indexes the words inside them, so article 6 was findable by searching `xss`. The integration test written to confirm the assumption failed. I chose a stripped `headline_text` column over documenting the limit (deviation 15).
- **It built a rule without asking.** A provider 4xx stops the run instead of failing the row. The rule is right, but it was a departure from the spec that the agent implemented first and flagged afterwards; I asked for the row (deviation 19). The same happened with two extra fields in the adversarial snapshot, which it listed as an assumption rather than a departure (deviation 21).
- **Its small-scale trial hid a failure.** The synthetic load was tried on 20,000 rows and passed; at 200,000 the parallel `VACUUM` ran out of shared memory in the container (`0c0121e`).
- **A skill and a test each carried their own expected results** and had already drifted apart on one query. Expected values now live in one file that both read (deviation 5).
- **My own spec was wrong in places the AI then built on.** `and` → 400 could never happen under the spec's own rules, and `no_searchable_terms` and `not_found` were error codes nothing could return (deviations 2, 3). Both were removed instead of kept untestable.

### What I would do differently with more time

- **Measure the two index cases I could not claim.** A rare search term, a term whose matches are all old, and a rare tag or an aggregate filtered by topic. Until then the GIN index on `tags` is "designed", not "used".
- **Repeat the model comparison.** More than one run and a second labeller, so the 17-against-14 result has a variance attached. Pin the upstream provider so latency means something.
- **Chinese word segmentation**, with `zhparser` or `pg_jieba`.
- **A rollup table for the aggregate**, which today reads every row.
- **Entity-level sentiment.** Sentiment here is the overall tone toward the article's main subject. A media-intelligence client wants sentiment toward their brand, which is a different prompt and a different schema.
- **A drift check:** re-score the golden set on every model or prompt change, and treat a shift in the sentiment distribution as a reason to stop and look.

---

## Not built

From spec §8, with what each would take:

| Not built                                    | What it would take                                                                                               |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Authentication, HTTPS, deployment            | Excluded by the brief                                                                                            |
| A long-running worker and a persistent queue | The enrich script already claims rows with `SKIP LOCKED`; the production shape is that script looping on a queue |
| Semantic caching                             | A validated similarity threshold; see [Guardrails](#guardrails-implemented)                                      |
| Chinese word segmentation                    | A Postgres extension and its own text-search config                                                              |
| Entity-level sentiment                       | A per-entity prompt and schema                                                                                   |
| Relevance ranking                            | `ts_rank` in the `ORDER BY`, which gives up the keyset order on date                                             |
| Zero-filled buckets                          | `generate_series` joined to the aggregate; the UI handles gaps today                                             |
| A Content-Security-Policy                    | One header in `next.config.ts`                                                                                   |
| A search engine other than PostgreSQL        | Not needed at this size                                                                                          |
