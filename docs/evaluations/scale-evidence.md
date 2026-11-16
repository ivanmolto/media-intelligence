# Scale evidence and budget stop — DRAFT

> **Draft for the README, written by the agent in phase 5. Not Ivan's text.** Phase 6 pastes from it under review. Every plan line quoted here is copied from [`explain.txt`](explain.txt); every budget line is copied from the command's output.

## Where the numbers come from

- [`explain.txt`](explain.txt), written by `npm run db:explain` at commit `0c0121e`, working tree clean. PostgreSQL 16.13, database `media_synthetic`, 200,000 articles, run key `mock / v1 / v1`. 15 cases in `scripts/explain-queries.json`, 15 run. Each case is run twice and the second run is recorded.
- The statements are the application's: each case goes through `lib/api/params`, `lib/search` and `listArticles` / `aggregateArticles`, which are handed a connection that puts `EXPLAIN (ANALYZE, BUFFERS)` in front of the statement. Parameters are bound.
- **The data is synthetic.** `scripts/synthetic.ts` draws words evenly from short lists and adds the search terms at rates set in the script (`renewable` 2%, `nuclear` 1.5%, `coal` 1.5%, `oil prices` 1%, `oil` 3%, `prices` 3%). Those rates are choices, not corpus measurements, and they decide what the planner picks. Timings describe this dataset in a local Docker container, warm cache. They are not production latencies.
- To reproduce: set `SYNTHETIC_DATABASE_URL` (see `.env.example`), `npm run db:synthetic`, `npm run db:explain`. Both run on the host; `explain.txt` is written to the working tree, so a reviewer with only Docker cannot regenerate it without a mount.

## The six indexes

| Index | Result on this dataset | Case |
| --- | --- | --- |
| `articles (published_at desc, id desc)` | uses the index | `list-first-page`, `list-page-50`, `list-by-date-range` |
| `articles (source, published_at desc, id desc)` | uses the index | `list-by-source` |
| `articles (language, published_at desc, id desc)` | uses the index | `list-by-language` |
| `articles using gin (tsv)` | uses the index for the phrase search and the searched aggregate; **not** for the three other search cases, where the planner walks a keyset index and filters | `search-phrase`, `aggregate-week-search` |
| `article_enrichments using gin (tags)` | **not used in any case.** No plan in the file names it | `list-by-topic` |
| dedup partial index | designed, unmeasured: the worker's lookup, no route query | — |

### Keyset pagination: page 50 costs what page 1 costs

`list-first-page`:

```
->  Index Scan using articles_published_idx on articles a  (cost=0.42..177988.76 rows=200058 width=102) (actual time=0.009..0.019 rows=21 loops=1)
Execution Time: 0.125 ms
```

`list-page-50`:

```
->  Index Scan using articles_published_idx on articles a  (cost=0.42..178451.25 rows=199049 width=102) (actual time=0.015..0.028 rows=21 loops=1)
      Index Cond: (ROW(published_at, id) < ROW('2026-06-27 10:36:27.741+00'::timestamp with time zone, '161833'::bigint))
Execution Time: 0.126 ms
```

The cursor is an index condition, 21 rows are read on both pages, and neither plan has a `Sort` node. Buffers: 108 and 109. Page 50 is as deep as the case goes; nothing deeper was run.

### Source, language and date filters

Each reads 21 rows from its index with no `Sort`:

```
->  Index Scan using articles_source_published_idx on articles a  ... (actual time=0.011..0.016 rows=21 loops=1)
      Index Cond: (source = 'Synthetic Wire 01'::text)
->  Index Scan using articles_language_published_idx on articles a  ... (actual time=0.013..0.026 rows=21 loops=1)
      Index Cond: (language = 'en'::text)
->  Index Scan using articles_published_idx on articles a  ... (actual time=0.011..0.024 rows=21 loops=1)
      Index Cond: ((published_at >= '2024-08-01 00:00:00+00'::timestamp with time zone) AND (published_at < '2024-09-01 00:00:00+00'::timestamp with time zone))
```

`Synthetic Wire 01` is the most common source (57,776 of 200,000) and `en` is 160,083 of 200,000, so these are the least selective values, not the most.

### Search: the GIN index is usable, and the planner does not always choose it

Where it is used, each language branch has its own scan (`search-phrase`, 2,033 matching rows):

```
->  BitmapOr  (cost=357.97..357.97 rows=289 width=0) (actual time=0.919..0.920 rows=0 loops=1)
      ->  Bitmap Index Scan on articles_tsv_idx  (cost=0.00..179.40 rows=239 width=0) (actual time=0.649..0.649 rows=1758 loops=1)
            Index Cond: (tsv @@ '''oil'' <-> ''price'''::tsquery)
      ->  Bitmap Index Scan on articles_tsv_idx  (cost=0.00..178.46 rows=50 width=0) (actual time=0.270..0.270 rows=450 loops=1)
            Index Cond: (tsv @@ '''oil'' <-> ''prices'''::tsquery)
Execution Time: 42.701 ms
```

The first scan is the `english` branch (stemmed to `price`), the second is `simple`. This plan has a `Sort` (top-N heapsort) because a bitmap scan returns no order. The planner estimated 201 rows and got 2,033. 175 rows were removed by the index recheck: GIN finds articles with both words, and the phrase's adjacency is checked on the heap.

Where it is not used (`search-boolean`, 3,777 matching rows):

```
->  Index Scan using articles_published_idx on articles a  (cost=0.42..180989.63 rows=2464 width=102) (actual time=1.298..22.378 rows=21 loops=1)
      Rows Removed by Filter: 1138
Execution Time: 22.481 ms
```

`search-prefix` (3,913 matching, 1,081 rows removed by filter, 9.732 ms) and `search-with-filter` (1,171 matching, walks `articles_source_published_idx`, 1,176 removed, 10.860 ms) do the same. With `ORDER BY published_at DESC LIMIT 21` and a term in about 2% of rows, the planner expects to find 21 matches sooner by walking the newest articles than by fetching and sorting every match. It was right here: about 1,100 rows read.

What this does and does not show:

- It shows the per-config fragment can be served by the GIN index (phrase, and the aggregate, which has no `LIMIT`).
- It does not show the walk is always cheap. Its cost grows as the term gets rarer or its matches get older, and it depends on the planner's row estimate, which was 10× low for the phrase. A rare-term case and an old-matches case are not in the queries file, so that is unmeasured.
- 2% is my rate. On real text the common search terms are more frequent and the rare ones far rarer than anything generated here.

### Topic filter: the tags index is not used

`list-by-topic` (`topic=ai`, 28,368 of 200,000):

```
->  Index Scan using articles_published_idx on articles a  ... (actual time=0.008..0.063 rows=152 loops=1)
->  Index Scan using article_enrichments_pkey on article_enrichments e  ... (actual time=0.002..0.002 rows=0 loops=152)
      Filter: (tags @> '{ai}'::text[])
```

Not a seq scan: the planner walks the newest articles and checks each one's tags through the primary key. Likely cause: the generator gives each article 1–3 of 14 tags evenly, so every tag is on about 14% of rows and 21 matches turn up within 152 articles. The index would matter for a rare tag, or for a query with no `LIMIT`. No case covers either, so for this index the README can say only **"designed; not chosen by the planner on this dataset"**. A proposal for Ivan, not made: add an aggregate case filtered by `topic` to `scripts/explain-queries.json`.

`list-by-sentiment` has no index of its own and does the same walk (111 articles read for 21 rows), as the phase notes expected.

### Aggregates read every row

`aggregate-week`, 200,000 rows:

```
->  Sort  (cost=31116.89..31617.04 rows=200058 width=32) (actual time=133.495..148.413 rows=200000 loops=1)
      Sort Method: external merge  Disk: 3536kB
      ->  Index Only Scan using articles_published_idx on articles a  (cost=0.42..8713.73 rows=200058 width=32) (actual time=0.022..94.227 rows=200000 loops=1)
            Heap Fetches: 0
Execution Time: 163.878 ms
```

A full read is expected: the query counts all rows. It is an index-only scan of the whole keyset index, not a selective use of it. Two findings:

- the sort spills to disk (`external merge`, 3.5 MB) at the default `work_mem`;
- the query groups by the `to_char` text of the bucket, so the index order of `published_at` is not used for grouping and everything is sorted again.

`aggregate-month` is the same shape (144.359 ms). `aggregate-month-by-sentiment` adds a parallel hash join to a `Parallel Seq Scan on article_enrichments` (131.858 ms). `aggregate-week-search` uses `articles_tsv_idx` through a `BitmapOr` and takes 42.707 ms for 3,913 rows.

Unfiltered aggregates grow linearly with the table. At real volume the answer is a rollup table or a date-bounded query, neither built.

## Budget stop (intent outcome 6)

Run on 2026-11-16 (UTC), mock mode. Two observations, because the first depends on what the day has already spent.

**1. The spec's command, on a stack that `docker compose up` had already enriched.** `enrichment_budget` held 75,205 tokens for the day before the command.

```
$ docker compose run --rm -e DAILY_TOKEN_BUDGET=1000 init npm run enrich -- --force
enrich: run key mock / v1 / v1: done 0 (copied 0), failed 0
enrich: budget_exceeded: the daily token budget is used up; 20 row(s) left pending. Run `npm run enrich` (without --force) once the budget allows.
exit: 2
```

**0 articles processed.** The day's use was already above 1,000, so the first reservation failed. A reviewer who runs this on the same UTC day as their `docker compose up` will see the same, since the mock run spends its fixture tokens too (19,337 for the 20 articles in the restore below). The live rows of both models were untouched (20 `done` each).

Restore:

```
$ docker compose run --rm init
enrich: run key mock / v1 / v1: done 20 (copied 0), failed 0
exit: 0
```

**2. A fresh daily budget of 1,000**, in a throwaway compose project with its own empty volume, so the app database is not touched:

```
$ docker compose -p media-signal-budget-demo run --rm -e DAILY_TOKEN_BUDGET=1000 init
migrate: applied 001_init.sql
seed: inserted 20 of 20 articles
enrich: run key mock / v1 / v1: done 1 (copied 0), failed 0
enrich: budget_exceeded: the daily token budget is used up; 19 row(s) left pending. Run `npm run enrich` (without --force) once the budget allows.
exit: 2
```

**1 article processed** (article 1: 838 input + 133 output = 971 tokens, which is what `enrichment_budget` held afterwards), 19 left `pending`, none `failed`.

## Fixed along the way

The first 200,000-row load inserted every row and then failed in `VACUUM (ANALYZE) articles`: `could not resize shared memory segment ... No space left on device`. A parallel vacuum allocates from the container's 64 MB `/dev/shm`. The script now runs `VACUUM (ANALYZE, PARALLEL 0)` (commit `0c0121e`). The 20,000-row trial had not shown it.
