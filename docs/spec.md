# Spec — Media Signal Service

Requirements and design. Derived from [`intent.md`](intent.md) and the assignment ([`ASSIGNMENT.md`](ASSIGNMENT.md)). Frozen together with [`plan.md`](plan.md); deviations go to [`deviations.md`](deviations.md).

Requirement ids: **R** = from the assignment, **S** = my own. Each maps to a phase in `plan.md`.

---

## 1. Data layer

### Requirements

- **R1** Load `sample_articles.json` (20 articles: headline, body, source, published_at, language).
- **R2** Efficient filtering by date range, source, language.
- **R3** Paginated list endpoint without deep-OFFSET cost.
- **R4** Aggregate endpoint: counts by month or week for a filter set.
- **R5** Indexes explained in the README.
- **S1** Seed is idempotent (re-run inserts 0).
- **S2** Enrichment data lives apart from source data and is versioned by model and prompt.
- **S12** `docker compose up` alone produces a searchable, enriched dataset: no manual step between clone and UI.

### Design

```
articles
  id            bigserial PK
  external_id   int unique            -- the brief's id
  headline      text                  -- may be '' (article 17)
  body          text                  -- raw, unsanitised; the source is evidence
  body_text     text                  -- HTML stripped; used for search and the LLM
  source        text not null
  language      text not null         -- 'en' | 'ar' | 'zh' | …
  published_at  timestamptz not null
  content_hash  bytea not null        -- sha256(normalised headline + body_text)
  tsv           tsvector generated always as (
                  CASE WHEN language = 'en'
                    THEN to_tsvector('english', coalesce(headline,'') || ' ' || body_text)
                    ELSE to_tsvector('simple',  coalesce(headline,'') || ' ' || body_text)
                  END) stored
                -- the config must be a constant in each branch: a config chosen
                -- by an expression is not immutable and a generated column rejects it

article_enrichments
  article_id        bigint references articles
  requested_model   text   -- 'mock', or the model id asked for
  prompt_version    text
  taxonomy_version  text
  PRIMARY KEY (article_id, requested_model, prompt_version, taxonomy_version)
  content_hash      bytea  -- the article's hash when this row was produced
  status            text   -- 'pending' | 'processing' | 'done' | 'failed'
  claimed_at        timestamptz
  summary           text
  sentiment         text   -- 'positive' | 'negative' | 'neutral' | 'mixed' | NULL
  tags              text[] -- 1..3 ids from the taxonomy
  model             text   -- as reported in the provider response
  provider          text   -- as reported in the provider response
  input_tokens      int
  output_tokens     int
  latency_ms        int
  cost_usd          numeric(10,6)
  error             text
  updated_at        timestamptz

enrichment_budget
  day          date PK    -- UTC
  tokens_used  bigint
```

**Run key.** `(requested_model, prompt_version, taxonomy_version)` identifies one enrichment run, so two models over the same 20 articles are two sets of rows and neither overwrites the other. The **active run key** comes from the environment (`LLM_MODE=mock` → `requested_model = 'mock'`; live → `ENRICH_MODEL`). The API and UI join each article to its row for the active run key only: one row per article, one join, no N+1.

Indexes:

- `articles (published_at desc, id desc)` — keyset pagination
- `articles (source, published_at desc, id desc)`, `articles (language, published_at desc, id desc)` — equality first, then the keyset order including its tiebreak
- `articles using gin (tsv)` — search
- `article_enrichments using gin (tags)` — topic filter
- `article_enrichments (content_hash, requested_model, prompt_version, taxonomy_version) where status = 'done'` — dedup lookup

**Startup.** Compose has three services: `db` (Postgres 16 with a healthcheck), `init` and `web`. `init` is one-shot and runs `migrate → seed → enrich` with `LLM_MODE=mock`, then exits 0. `web` depends on `init` with `condition: service_completed_successfully`, so the UI never starts on an empty or un-enriched database. All three steps are idempotent; restarting the stack inserts and enriches nothing.

**Scale evidence** (intent outcome 7). `scripts/synthetic.ts` generates ~200k articles with matching enrichment rows, written directly with no provider calls, into a separate database so the 20-article UI is unaffected. `EXPLAIN (ANALYZE, BUFFERS)` for the list, filter, search and aggregate queries is run against it and pasted in the README. On 20 rows Postgres seq-scans and that is stated. If cut for time, the README says the indexes are designed but unmeasured and never claims they are used.

### Pagination

Keyset: `WHERE (published_at, id) < ($cursor_ts, $cursor_id) ORDER BY published_at DESC, id DESC LIMIT $n`. Cursor is base64 of `{ts, id, filter_hash}`; a cursor whose `filter_hash` doesn't match the request's filters → 400.

### Aggregate

`SELECT date_trunc($bucket, published_at AT TIME ZONE 'UTC') AS bucket, count(*) … GROUP BY 1 ORDER BY 1`, where `$bucket ∈ {month, week}` is mapped from a whitelist to a constant. **Default bucket: week** (the sample spans ~5 weeks; month gives two bars). Month remains selectable. Optional `group_by ∈ {sentiment, source, topic}` joins enrichments for the active run key; un-enriched articles appear as `sentiment = NULL`. With `group_by = topic` an article with several tags is counted once per tag, so the groups do not sum to the article total; the response and the README say so. Takes the **same `WHERE` fragment** as search (§2), so search and chart never disagree. Empty buckets are not zero-filled; the UI handles gaps.

---

## 2. Boolean search

### Requirements

- **R6** Operators `AND`, `OR`, `AND NOT`; nested brackets; `"phrase"`; trailing `*` wildcard.
- **R7** Operators are case-sensitive: `and` is a term.
- **R8** The three example queries behave as specified.
- **S3** Malformed queries return 400 with a message; never 500. This includes terms and prefixes made of quote and operator characters (`a'b:c&d*`).
- **S4** Query length ≤ 500 chars, ≤ 32 terms, nesting ≤ 8.
- **S5** Adjacent terms imply AND, so `oil and gas` (lowercase `and` is a term, per R7) searches rather than errors.
- **S6** A term that is a stop word under a text-search config contributes nothing to the match for articles in that config and is reported in `warnings`; it never silently makes the query match nothing.

### Grammar

```
query   := or
or      := and ( "OR" and )*
and     := unary ( ( "AND" | "AND" "NOT" )? unary )*     -- adjacency = AND
unary   := "(" or ")" | PHRASE | PREFIX | TERM
PHRASE  := '"' [^"]+ '"'
PREFIX  := TERM '*'
TERM    := [^\s()"*]+          -- but not exactly AND / OR / NOT
```

- Precedence: AND and AND NOT bind tighter than OR. Adjacency binds as AND.
- Bare `NOT`, `OR NOT`, leading/trailing operator, unbalanced brackets, unterminated quote, `*` alone, leading `*` → 400.
- Terms match case-insensitively; operators match case-sensitively.
- Search surface: `tsv` (headline + body_text). Never the summary.

### Compilation

AST → SQL `WHERE` fragment. The AST is compiled **once per text-search config** and the two fragments are joined under a language guard:

```
(a.language =  'en' AND <fragment compiled with 'english'>)
OR
(a.language <> 'en' AND <fragment compiled with 'simple'>)
```

The config is a constant inside each fragment. A config resolved per row would make every tsquery row-dependent and the GIN index on `tsv` unusable.

Each leaf is one parameter:

- TERM → `tsv @@ plainto_tsquery('<cfg>', $n)`
- PHRASE → `tsv @@ phraseto_tsquery('<cfg>', $n)`
- PREFIX → `tsv @@ (plainto_tsquery('<cfg>', $n)::text || ':*')::tsquery` — Postgres normalises and quotes the lexeme; the app never concatenates user text
- AND / OR / AND NOT → SQL `AND` / `OR` / `AND NOT`, parenthesised as in the AST

No tsquery string is ever assembled from user text in the application.

**Empty-leaf rule.** Only Postgres knows each config's stop list, so before compiling, one query asks for `numnode(…_tsquery(cfg, $n))` for every leaf under both configs. Then, per config:

- a leaf whose tsquery is empty under that config (`and`, `the` under `english`) is removed from that config's fragment; an operator left with one operand collapses to that operand, and `x AND NOT <removed>` becomes `x`;
- a fragment with no leaf left matches nothing for that config's articles;
- if neither fragment has a leaf left → 400 `no_searchable_terms`.

A leaf removed under `english` is appended to `warnings`. Under `simple` there is no stop list, so `and` stays a required literal term for `ar`/`zh` articles. Rationale: `tsv @@ ''::tsquery` is false, so without this rule `oil and gas` would return nothing with no explanation.

### Fixed tests

| Query                                                    | Result                                                                            |
| -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `"oil prices" AND (geopolitical OR "supply chain")`      | `[1]`                                                                             |
| `renewable AND NOT (nuclear OR coal)`                    | `[5]`                                                                             |
| `AI AND ("healthcare" OR "diagnostic") AND NOT startup*` | `[]`                                                                              |
| `AI and healthcare`                                      | `[10]`, `warnings: ["and"]` (`and` is a term; stop word dropped; adjacency = AND) |
| `oil and gas`                                            | `[]`, `warnings: ["and"]` (no article has both)                                   |
| `and`                                                    | 400 `no_searchable_terms`                                                         |
| `(AI OR energy`                                          | 400                                                                               |
| `NOT AI`                                                 | 400                                                                               |
| `a'b:c&d*`                                               | not 500 (S3)                                                                      |

### Known limits (stated in README)

- `english` config stems and drops stop words (`"prices of oil"` → positional gap).
- A prefix is matched against stemmed lexemes for English articles, so a prefix longer than the stem can miss (`renewab*` against the stem `renew`).
- `simple` config for `ar`/`zh` tokenises on whitespace only; Chinese is not segmented (pg_jieba/zhparser would be the fix).

---

## 3. LLM enrichment

### Requirements

- **R9** Per article: 1–2 sentence summary, sentiment ∈ {positive, negative, neutral, mixed}, 1–3 topic tags.
- **R10** Model choice justified on cost / quality / latency.
- **R11** Cost at 50,000 articles/day.
- **R12** At least one cost guardrail.
- **S7** Mock mode is the default and **makes no network calls**; `docker compose up` works offline and needs no key.
- **S8** Live mode runs only with the operator's own key from the environment. No key is shipped and no proxy is hosted.
- **S9** Every call's model, provider, tokens, latency and cost are recorded from the response.
- **S10** Live evaluation is bounded: at most two models, once each over the 20 articles; plus one pass of the adversarial fixtures on each evaluated model (a logged deviation from the intent's cost constraint, see §6).
- **S11** Because a reviewer may never run live, the repo carries the evidence of the live run: mock fixtures derived from it, an exported `article_enrichments` snapshot (`docs/evaluations/enrichments-<model>.json`), and the measured cost table.

### Model selection (R10)

The two model names are not chosen in this spec; they are resolved in [`plan.md`](plan.md) (§9), where prices are looked up and dated. The criteria are fixed here.

A candidate must:

- be available through OpenRouter with a published list price that can be cited with a URL and retrieval date;
- support `response_format` with a JSON schema, so the output contract is enforced by the provider and not only by the prompt;
- accept Arabic and Chinese input and produce English output.

The two candidates come from different price tiers (one small, one mid-tier), so the comparison measures what the extra spend buys.

Both are scored on the same 20 articles:

| Dimension | Measure                                                                                  |
| --------- | ---------------------------------------------------------------------------------------- |
| Quality   | sentiment agreement and tag validity against `tests/golden.json`; first-attempt schema-valid rate |
| Cost      | provider-reported tokens × dated list price, per article                                 |
| Latency   | p50 and p95 over the 20 calls — reported, not decisive                                   |

Decision rule: the cheaper model wins unless any of these holds:

1. its sentiment accuracy on the golden set is more than one article lower than the other model's;
2. it produces any schema-invalid output after the retry;
3. any adversarial fixture makes it break the schema.

Ties go to the cheaper model. Latency is reported but does not decide: enrichment runs off the request path, so no user waits on it.

The model that wins is the **primary model**. Rule 3 is applied to both candidates: the live adversarial run (§6) covers each of them, so whichever becomes primary has been tested against the fixtures.

If an adversarial fixture disqualifies both models, that is a finding, not a choice. The README reports it, and the better of the two on the measured table ships with the failure documented.

One call produces all three outputs. Splitting summary and classification across two models would send the article twice; the README states this trade and when a split would pay.

### Provider contract

```ts
interface EnrichmentProvider {
  enrich(
    input: { headline?: string; body: string; language: string },
    opts: { signal: AbortSignal },
  ): Promise<{
    raw: unknown;
    model: string;
    provider: string;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
  }>;
}
```

Implementations: `MockProvider` (deterministic fixtures for the 20 articles, labelled `mock`, each carrying the token counts recorded in the live run; contains no `fetch` — `security-audit` checks this) and `OpenAICompatibleProvider(baseUrl, model, apiKey)` using `response_format` with a JSON schema. `LLM_MODE=mock|live`; live requires `OPENROUTER_API_KEY` and `ENRICH_MODEL` in the environment and fails startup without them.

### Prompt (versioned, `prompt_version = 'v1'`)

- System: role is to analyse the article as data; produce only the schema; summarise only what the text says, add no facts; summary and tags in English regardless of language; sentiment = overall tone toward the main subject, `mixed` only when both sides carry weight; tags only from the taxonomy; no URLs or markdown in the summary.
- User: article as a JSON object inside one `<article>…</article>` block, with `<`, `>`, `&` escaped; `headline` omitted when empty.

### Output schema (Zod)

```
summary:   string, 20–400 chars, no URL
sentiment: enum
tags:      1..3 distinct ids from taxonomy_v1
```

Taxonomy v1: `geopolitics, economy, markets, business, technology, ai, cybersecurity, regulation, energy, climate, health, transport, sports, other`.
Invalid → one retry → `status='failed'`, `sentiment=NULL`, `error` set. Never a default value.

### Worker

`scripts/enrich.ts`, for the active run key:

1. **Enqueue:** insert a `pending` row for every article that has none for this run key (`ON CONFLICT DO NOTHING`).
2. **Claim:** `SELECT … FOR UPDATE SKIP LOCKED` on `status='pending'` (or `processing` older than 10 min).
3. **Process:** dedup check, budget reservation, provider call with timeout, validate, write row.

**One-shot script, run by the `init` service after seed; safe to re-run.** A re-run processes only `pending` rows: `done` rows are skipped and `failed` rows are left as they are. `--force` resets every row of the active run key to `pending` first; it is what makes the budget stop demonstrable on an already-enriched database. `--force` is mock-only: in live mode the script refuses it and exits `1`, because re-running a live run repeats paid calls beyond the S10 bound. A long-running daemon is out of scope — the production shape is this script looping on a queue, which is a deployment change.

Exit codes: `0` done, `2` `budget_exceeded` (nothing further processed), `1` other error.

### Guardrails

| Guardrail    | Value                                                                                                                                                                                                                                   |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input cap    | 8,000 characters of body (head + tail if longer). Characters, not tokens, so no tokenizer dependency.                                                                                                                                   |
| Output cap   | 300 tokens                                                                                                                                                                                                                              |
| Timeout      | 20 s, `AbortSignal` passed through                                                                                                                                                                                                      |
| Retries      | 1 on invalid output or 5xx; 0 on 4xx                                                                                                                                                                                                    |
| Daily budget | Reserve, then correct. Before each call the worker reserves `est = ceil(chars / 4) + prompt_tokens + output_cap`, where `chars` is the capped article text, `prompt_tokens` is the fixed token count of the versioned system prompt and `output_cap` is 300. The reservation is one atomic statement: `UPDATE enrichment_budget SET tokens_used = tokens_used + $est WHERE day = $d AND tokens_used + $est <= $budget RETURNING tokens_used`. No row returned means stop: exit `2`, `budget_exceeded`, nothing further processed. After the call the reservation is corrected to the provider-reported tokens. Mock calls count their fixture tokens, so the stop works offline. |
| Dedup        | skip the call if a `done` enrichment exists for the same `(content_hash, requested_model, prompt_version, taxonomy_version)`; its result is copied                                                                                      |
| Concurrency  | `ENRICH_CONCURRENCY` (default 3). Reservation is atomic, so concurrent calls cannot jointly pass the budget; any overshoot is one call's estimation error.                                                                              |

**Budget observable** (intent outcome 6): `docker compose run --rm -e DAILY_TOKEN_BUDGET=1000 init npm run enrich -- --force` exits `2` with `budget_exceeded` before the 20 articles are done. How many articles it processes first is not claimed here; the README reports it once measured. Afterwards `docker compose run --rm init` restores the full enrichment.

### Cost analysis (README)

Measured: provider-reported tokens over the 20 live calls; list price with URL and retrieval date; per-article cost; × 50,000. Hypothetical 1,500-token article in a separate, labelled column. Self-hosted: formula (`GPU-hours × price + ops`), what would be measured (throughput at target latency, prefix-cache hit on the shared system prompt), break-even volume. No invented numbers.

---

## 4. API

| Endpoint                      | Params                                                                                          | Returns                                                                                                   |
| ----------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `GET /api/articles`           | `q`, `source`, `language`, `sentiment`, `topic`, `from`, `to`, `cursor`, `limit` (≤100)         | `{items: [{id, headline, source, language, published_at, enrichment?}], next_cursor, warnings: string[]}` |
| `GET /api/articles/aggregate` | same filters + `bucket ∈ {month,week}` (default `week`), `group_by ∈ {sentiment,source,topic}?` | `{buckets: [{bucket, group?, count}], warnings: string[]}`                                                |
| `GET /api/health`             | —                                                                                               | `{ok: true}`                                                                                              |

`sentiment` and `topic` filter on the enrichment row for the active run key (`topic` uses the `tags` GIN index); both are validated against their enums.

All params validated with Zod; identifiers whitelisted; errors `{error: {code, message}}` with 400/404/500; no SQL or provider text in responses. Route handlers call `lib/`; no SQL in route files.

Error codes: `invalid_query` (400, with the parser message), `no_searchable_terms` (400), `invalid_cursor` (400), `invalid_param` (400), `not_found` (404), `internal` (500). Enrichment rows carry `error ∈ {invalid_output, timeout, provider_error}`; a budget stop leaves rows `pending` and is reported by the worker's exit code.

---

## 5. UI

Both pages are required; neither is on the cut list.

- **Search page** `/`: query input; errors shown inline (400 message); `warnings` shown inline ("'and' was ignored as a stop word") so the lowercase-`and` behaviour is visible; result cards with headline (or `(Untitled)`), source, date, summary, sentiment badge, tag chips; "0 results" state distinct from error state; cursor-based "Load more".
- **Aggregate page** `/trends`: Recharts bar chart of counts by bucket; bucket toggle; one filter dimension (sentiment); same `q`/filters as search carried in the URL.
- All article and enrichment text rendered as React text nodes. No `dangerouslySetInnerHTML` (hook-enforced).
- Functional, not styled beyond Tailwind defaults.

---

## 6. Security

| Threat                      | Control                                                                                    | Evidence                                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| SQL injection               | Every value a `$n` param; identifiers whitelisted; no tsquery string from user text        | grep in `security-audit`; reviewer policy                                                                                             |
| XSS (articles 6, 18)        | Text nodes only; no `dangerouslySetInnerHTML`, hook-enforced                               | `tests/render.test.tsx` asserts escaped output — intent outcome 4                                                                     |
| Prompt injection            | Delimited escaped block; HTML stripped; schema as boundary; no tools; no URLs in summaries | `tests/adversarial.test.ts` over `tests/fixtures/adversarial.json` (override, sentiment steering, exfiltration, forged `</article>`) — intent outcome 5 |
| Output-channel exfiltration | No URLs/markdown in summaries; nothing from model output is fetched or linked              | same test, `no_url_in_summary` case                                                                                                   |
| Cost runaway                | Caps, timeout, budget, dedup, concurrency                                                  | `tests/guardrails.test.ts`; budget stop demonstrable per §3 — intent outcome 6                                                        |
| Mock isolation              | `MockProvider` makes no network calls                                                      | `security-audit` static check: no `fetch` in `lib/enrich/mock.ts`                                                                     |
| Secrets                     | `.env` gitignored; pre-commit hook blocks `.env` and key patterns                          | hook                                                                                                                                  |

**What the adversarial test proves.** It runs offline, without a key, and asserts the deterministic controls: the prompt builder escapes each fixture so a forged `</article>` cannot close the block; HTML is stripped; and the validator rejects a compromised output (a URL in the summary, a tag outside the taxonomy, an invalid sentiment) instead of storing it. It does not prove that a live model ignores planted instructions — the mock returns fixtures whatever the input.

**Live adversarial run.** To cover that gap, the adversarial fixtures are run live once, on each evaluated model (both candidates, or the single model if the comparison is cut), one call per fixture, under the same guardrails as enrichment. Each fixture's input, the raw model output and the validator's verdict are exported to `docs/evaluations/adversarial-<model>.json`, and the README reports the result as observed, including any fixture where the model was steered. This is the evidence a reviewer without a key reads for intent outcome 5. These calls go beyond the intent's limit of the 20 articles and are logged in `deviations.md`.

A Content-Security-Policy is not built. The README has one line on it as defence-in-depth.

---

## 7. Observability and evaluation

- `article_enrichments` rows are the metrics: status counts, p50/p95 latency, tokens, cost per run key — one SQL query, pasted in the README.
- `tests/golden.json`: hand-labelled sentiment and acceptable tags for the 20 articles. `scripts/score.ts` (about 30 lines) compares one run key's rows against it and prints sentiment agreement and tag validity. A JSON file and a scorer, not an evaluation framework.
- Drift canary (production note, not built): re-score the golden set on every model or prompt change; a sentiment-distribution shift beyond a band opens a new intent.
- Cold `docker compose up` build-to-ready time is measured once on a clean checkout and stated in the README; no "within a minute" claims without it.

---

## 8. Out of scope

Authentication, HTTPS, deployment, a long-running (daemon) enrichment worker and persistent queue, semantic caching, Chinese word segmentation, entity-level sentiment, relevance ranking, zero-filled buckets, a Content-Security-Policy, any search engine other than PostgreSQL. Each has one README line on what it would take.

---

## 9. Deferred to the plan

1. **Which two models.** The criteria and decision rule are fixed in §3. The names are resolved in `plan.md`, with each list price cited by URL and retrieval date.
