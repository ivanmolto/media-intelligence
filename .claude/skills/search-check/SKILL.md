---
name: search-check
description: Verify the boolean search pipeline end to end — parse a query, show the AST and compiled parameterised SQL, run it, compare article ids, warnings and error codes against the shared expectations file. Use after any change under lib/search/ or when a search result looks wrong.
---

# search-check

Run after every change to `lib/search/` and before proposing a commit that touches it.

## Expectations

All expectations live in `tests/fixtures/search-expectations.json`. The Vitest search suite reads the same file. This skill holds none: do not copy cases or expected values into it, and do not check a query from memory.

The file's `about` block defines the fields. `docs/spec.md` §2, as amended by `docs/deviations.md`, is the source of truth for cases whose `source` is `spec` or `deviation-N`.

## Preconditions

- The database is up, migrated and seeded (`npm run migrate && npm run seed`). Search does not depend on enrichment.
- `npm run search:debug` exists (`scripts/search-debug.ts`). It takes one query as its argument.
- If the database is unreachable, the script is missing or the expectations file does not parse, say so and stop. Do not report a row of ✗ for a setup failure.

## Steps

1. `npm test -- tests/parser tests/search`
2. Read `tests/fixtures/search-expectations.json`. For **every** case run `npm run search:debug -- '<query>'` and print:
   - the AST, on one line;
   - the empty-leaf pre-query result: which leaves are empty under `english` and under `simple`;
   - **both** compiled `WHERE` fragments (`english` and `simple`) with the parameter array;
   - the matching `external_id`s and the `warnings` array, or the error code.
3. For each case with `sqlMustNotContain`, search the printed SQL text of both fragments for each substring. Do not judge by eye.
4. Report a table: id | query | expected | actual | ✓/✗. State the number of cases in the file and the number run; they must be equal.

A `fixed` case passes only if ids, warnings, error code and the SQL check all match. A `provisional` case is run and reported with its actual result, marked `provisional`, never ✗.

Quoting: wrap the query in single quotes. For a query that contains a single quote use double quotes: `"a'b:c&d*"`.

## Rules

- **`fixed` expectations are fixed.** If actual ≠ expected, the code is wrong. Never edit the expectations file, a fixture or a test to pass. Name the AST node or compile step that produced the wrong SQL.
- **Changing the file is a human decision.** Adding a case, or moving one from `provisional` to `fixed`, happens only when the user asks, with the evidence (the spike output) shown first.
- **The spec wins.** If an expectation contradicts `docs/spec.md` §2 as amended by `docs/deviations.md`, or the spec contradicts itself, stop and report the conflict. Do not change code, the file or the spec to resolve it.
- `spec-ai-healthcare-not-startup` returning `[10]` means one of: `AND NOT` is applied inside the OR group; negation is dropped; or the `startup*` leaf was wrongly reported empty, so `x AND NOT <removed>` collapsed to `x`. Check precedence first, then the pre-query output.
- A missing or extra entry in `warnings` is a failure of the empty-leaf step (`lib/search/leaves.ts`), not of the parser.
- If any user token appears inside the SQL string instead of the parameter array, stop and report HIGH — that is the injection surface. The config names `'english'` and `'simple'` are constants and are expected in the SQL.
