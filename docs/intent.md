# Intent — Media Signal Service

**Originator and product owner:** Ivan Molto.
**Status:** accepted and committed before any code. Later changes are rows in [`deviations.md`](deviations.md).

## Problem

A media intelligence company's platform ingests large volumes of news and lets analysts search it with boolean queries and read AI-generated summaries, sentiment and topics. The home assignment asks for a small, runnable version of that pipeline over 20 sample articles — with the real constraints: boolean query parsing, LLM enrichment that must be cheap and bounded, SQL that would still work at scale, and untrusted content at every boundary (articles contain script injection; some are Arabic and Chinese; one has no headline).

The assignment is graded on judgment: plan quality (15%), correctness (20%), SQL and performance (15%), LLM choice and cost reasoning (20%), security (15%), and the AI transcript plus reflection (15%). Half the grade is reasoning and process, not code.

## Outcome

A reviewer can clone the repo and, after `docker compose up` completes:

1. search the articles with the brief's boolean syntax and get the expected results — including that `AI AND ("healthcare" OR "diagnostic") AND NOT startup*` returns nothing;
2. see each article's summary, sentiment badge and topic tags, produced without an API key (mock mode) and reproducible with one (OpenRouter);
3. see article counts per week or month, filterable, consistent with search;
4. confirm that articles 6 and 18 render inert and article 17 shows `(Untitled)`;
5. run the adversarial fixture test and see that instructions planted in article text do not change the enrichment output;
6. set `DAILY_TOKEN_BUDGET=1000`, run enrich, and watch it stop with a budget error;
7. page through the article list with a cursor and see the `EXPLAIN` plan for that query on synthetic rows;
8. read a README whose Plan predates the code in git history, whose cost section is measured and dated, and whose Reflection is backed by a deviations log and a full transcript.

The deeper outcome: show how I scope and build with AI agents — a frozen plan, plan-mode per phase, a cold reviewer, hooks for the deterministic rules, and a human gate on every merge.

## Affected users and systems

**Users**

- **The reviewer** — the only real user. Clones the repo, runs it locally, tries the brief's queries and reads the README, git history and transcript.
- **The analyst** — the notional end user the brief describes. Shapes the search syntax and the UI, but nobody in this role will use the service.

**Systems**

- **The reviewer's machine** — Docker and a browser. Nothing else is installed or changed.
- **PostgreSQL 16 and the Next.js app** — both run inside compose and hold only the 20 sample articles.
- **OpenRouter** — the one external service, called only when the reviewer supplies their own API key. Mock mode makes no network calls.
- **`sample_articles.json`** — untrusted input to the database, the LLM prompt and the browser.

No production system, company system or personal data is touched.

## Constraints

- **Time:** 7–9 focused hours of build. Docs, PR triage, transcript exports and the live cost measurement are budgeted separately.
- **Stack:** Next.js + TypeScript + Postgres 16 in compose.
- **Scope:** no auth, HTTPS, deployment, queue, vector DB, or design system. "Don't gold-plate" is an explicit grading instruction.
- **Cost:** live LLM calls limited to the 20 articles, once per model evaluated, at most two models; mock mode is the default path.
- **Honesty:** no invented prices, benchmarks or test claims. Anything not measured in this repo is written as a formula or a stated limit.
- **Process:** every AI interaction is exported to `docs/ai-transcript/`; the plan is frozen before the first code commit. Departures from it are logged in `deviations.md` — a deliberate variation on the AI-native SDLC playbook, which edits the plan in the same commit instead.

## Decisions taken at intent

| Question                                      | Decision                                                                                                                                                        |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Implicit AND between adjacent terms?          | Yes — adjacent terms are ANDed, so `oil and gas` searches for three terms and demonstrates the brief's rule that lowercase `and` is a term, not an operator.   |
| Bare `NOT` / `OR NOT`?                        | Rejected (400). Only `AND NOT` is an operator.                                                                                                                  |
| Summary language for Arabic/Chinese articles? | English, always. Topic ids are English; UI maps to labels.                                                                                                      |
| Sentiment perspective?                        | Overall tone toward the article's main subject; `mixed` only when both sides carry weight. Entity-level sentiment per client brand is the production follow-up. |
| Semantic caching?                             | Not built. Documented with its failure mode and the knobs that would have to be right.                                                                          |
| Showing scale with only 20 rows?             | `EXPLAIN` plans on synthetic rows, because 20 rows cannot demonstrate index or pagination choices. The row count is set in the spec.                             |
| Which phases get a PR + cold review?          | 2, 3, 4, 6 — where the diff contains judgment.                                                                                                                  |

## Open questions

1. **Which two models to evaluate?** The count is fixed at two; the candidates are not chosen.
2. **Week or month as the default bucket?** The sample spans 12 June to 14 July 2026, so month gives two bars and week gives about five.
## Not in scope

Production deployment, multi-tenant anything, real-time ingestion, entity-level sentiment, model fine-tuning, a search engine other than PostgreSQL, Chinese word segmentation, a long-running (daemon) enrichment worker. Enrichment runs as a one-shot script.
