---
name: security-audit
description: Run the security tests, the security-audit script and the static checks that need tracing (SQL parameterisation, identifier allow-list, XSS sinks, adversarial fixture, mock isolation, secrets) and produce a pass/fail table for the README Security section. Use before any PR that touches lib/search/, lib/enrich/, lib/articles/, app/ or components/, before the phase-6 PR and before submission.
---

# security-audit

## Sources

This skill holds no expected values. Do not copy cases, article ids, parameter lists, key patterns or expected output into it, and do not judge a case from memory.

- `docs/spec.md` §6, as amended by `docs/deviations.md`, lists the threats, the controls and which test or check is the evidence for each. §4 lists the request parameters.
- `scripts/security-audit.ts` (`npm run security-audit`) owns the deterministic rules: no `fetch` in the mock provider, no SQL in route files, no string-built SQL. The pre-commit hook does not run it. This skill runs it and does not re-implement its rules.
- `scripts/secret-patterns.txt` holds the key patterns, one extended regex per line. The pre-commit hook reads the same file.
- `tests/fixtures/adversarial.json` holds the adversarial cases; `tests/adversarial.test.ts` reads the same file.
- Which articles carry XSS payloads, and what they must render as, is asserted in `tests/render.test.tsx`.

`SRC` below means `app lib components`: every directory that holds application source. If the repo has another one, add it and say so.

## Preconditions

- The compose `db` service is up. The tests make no network call and need no API key, but Vitest's global setup creates and seeds `media_test`, and the budget guardrail is a SQL statement. "Offline" means no network, not no database.
- If a directory or file a check scans does not exist, that check is `NOT CHECKED` with the missing path as the reason.
- If `tests/fixtures/adversarial.json` is missing or does not parse, the fixture checks are `FAIL`.

## Steps

1. Record `git rev-parse --short HEAD`, whether the tree is dirty (`git status --porcelain`), and today's date.

2. `npm test -- tests/render tests/adversarial tests/guardrails`
   - For each of the three filters, state the number of test files and tests collected. Zero collected is `FAIL`, not a pass.
   - Cite test names from this run as evidence in step 5. A test that was skipped or `todo` is not evidence.

3. `npm run security-audit`. Print its output. A non-zero exit is `FAIL` for the rule it names; a missing script is `NOT CHECKED` for all three of its rules. Its three rules are reported as three rows.

4. Checks that need tracing or judgement. Run the command, print its output, then give the verdict. Every hit is listed with `file:line`.

   **a. HTML and code-execution sinks** — any hit is `FAIL`.
   `grep -rnE 'dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(' SRC`
   Also cite the pre-commit hook's check that blocks `dangerouslySetInnerHTML` (spec §6: "hook-enforced", as amended by deviation 12); if the hook has no such check, or fails the hook conditions in the secrets step, `FAIL`.

   **b. Link targets from data** — list every hit of
   `grep -rnE '(href|src|action)=\{' SRC`
   Each is `PASS` only if the value is a constant or a route built from an id. A value that comes from an article field or from model output is `FAIL`.

   **c. Outbound requests** — list every hit of
   `grep -rnE '\bfetch\(' SRC scripts`
   Each is `PASS` only if the URL is a constant, one of the app's own routes, or the provider base URL from the environment. A URL built from an article field or from model output is `FAIL` (spec §6: nothing from model output is fetched).

   **d. SQL parameterisation**
   1. Identify the Postgres driver from `package.json` and the one module that creates the pool or client. State both. List any other file that imports the driver.
   2. Enumerate every call site using that driver's API (for `pg`, `grep -rnE '\.query\(' SRC scripts`; for a tagged-template driver, every use of the tag).
   3. For each call, open the file and trace the SQL text to where it is built. `PASS` only if the text is a string constant, or is concatenated solely from constants and allow-list lookups, with every value in the params array. Any `${…}` or `+` that brings in a request value, a user token or a database value is `FAIL`.
   4. Report the number of call sites found and the number traced; they must be equal. Zero call sites is `NOT CHECKED`, not a pass: it means the enumeration did not match the driver.

   This is the traced complement of the script's "no string-built SQL" rule. If the two disagree, report both results.

   **e. tsquery construction** — list every hit of
   `grep -rnE '(to_tsquery|phraseto_tsquery|plainto_tsquery|websearch_to_tsquery)\(|::tsquery' SRC scripts`
   - A function call is `PASS` only if its text argument is a `$n` parameter.
   - A `::tsquery` cast is `PASS` only if the cast expression is built inside SQL from a `*_tsquery($n)` result and constants (the spec's prefix form). A string assembled in the application and then cast is `FAIL`.
   - The config names `'english'` and `'simple'` are constants and are expected in the SQL.

   **f. Identifier and enum allow-lists** — from spec §4, take every request parameter that selects an SQL identifier or constant, and every parameter the spec says is validated against an enum. For each, find where the request value is read and where it reaches SQL. `PASS` only if an identifier comes from a lookup in a constant object, an enum value is validated before use, and an unknown value is rejected before any SQL is built. Cite the lookup's or schema's `file:line`. If a test feeds hostile values to these parameters, cite it too; if none exists, say so in the evidence column.

   **g. Summary validator** — evidence is the tests, not a reading of the code. Cite the test from step 2 that rejects a URL in the summary (spec §6, `no_url_in_summary`); a missing test is `FAIL`. Markdown is not a validator control (deviation 10): do not require a test for it and do not report a row for it.

   **h. No tools in the provider request** — `grep -rnE '\btools\b|tool_choice|\bfunctions\b|function_call' lib/enrich`. Any hit inside a request body is `FAIL` (spec §6: no tools).

   **i. Adversarial fixture coverage** — read `tests/fixtures/adversarial.json` and list its case ids. Every case category named in the Prompt injection row of spec §6 must be present, including the forged closing-delimiter case. A missing category is `FAIL`. State the number of cases in the file and the number the test ran; they must be equal.

   **j. Live adversarial evidence** — for each `docs/evaluations/adversarial-<model>.json`, report the model, the number of fixtures and the validator verdict counts as they appear in the file. If there is no such file, write "live: not run". This row has no `PASS` or `FAIL`; it is reported as observed.

   **k. Secrets**
   - `git check-ignore -q .env` must exit 0.
   - `git ls-files | grep -E '(^|/)\.env($|\.)'` — only `.env.example` may be tracked.
   - The two scans below end in `cut` so that only `file:line` is printed. Do not run them without it, and do not open a file at a hit to look: this session's output is exported as a transcript and committed.
   - Tracked files: `git grep -nIE -f scripts/secret-patterns.txt | cut -d: -f1,2` — any hit is `FAIL`. The patterns are written not to match the empty placeholders in `.env.example`; a hit there is still a hit, in the file or in the patterns.
   - Untracked files that are not ignored: `git ls-files -o --exclude-standard -z | xargs -0 grep -HnIE -f scripts/secret-patterns.txt | cut -d: -f1,2`. Any hit is `FAIL`. Say explicitly whether `docs/ai-transcript/` and `docs/evaluations/` were scanned: transcripts and raw model output are the likeliest place for a pasted key.
   - History: for each line `p` of the patterns file, `git log --all --oneline -G "$p"` must print nothing. A key that was committed and later removed is `FAIL` and must be rotated.
   - The pre-commit hook: cite its path. `PASS` only if it is a tracked file (`git ls-files --error-unmatch <path>`), is executable, reads `scripts/secret-patterns.txt`, and is wired in (`git config core.hooksPath` points at its directory, or the repo's install step does it). A hook that exists only in `.git/hooks` is `FAIL`: a reviewer's clone does not have it.
   - If `scripts/secret-patterns.txt` is missing, the three pattern checks are `NOT CHECKED`.

   **l. Content-Security-Policy** — the spec does not build one (§6, §8). `PASS` if no CSP header is set and the README has its one line saying so. `FAIL` if the README claims a CSP that the code does not set, or the line is missing.

5. Output, suitable to paste into the README:
   - a header line: commit, `clean` or `dirty`, date;
   - a table: check | result | evidence (test name or `file:line`);
   - a count of `PASS`, `FAIL` and `NOT CHECKED`.

   The prompt-injection rows are worded by what was shown, never "the model resists injection":
   - offline: "`PASS` — prompt builder escapes the fixtures, HTML is stripped, the validator rejects compromised output" (spec §6, what the adversarial test proves);
   - live: the row from check j, as observed, including any fixture where the model was steered.

## Rules

- Report, don't fix, unless a human asks. The table is the deliverable.
- A check you could not run is `NOT CHECKED` with a reason — never `PASS` by default.
- A grep with no hits is evidence only if the scanned paths exist and contain source files. Say which paths were scanned.
- Never edit a test, a fixture, `scripts/security-audit.ts`, `scripts/secret-patterns.txt` or this skill to turn a `FAIL` into a `PASS`.
- If a check here contradicts `docs/spec.md` §6 as amended by `docs/deviations.md`, stop and report the conflict. Do not change code, the skill or the spec to resolve it.
- If a `dirty` tree was audited, say so above the table; the result does not describe the commit.
- Print no secret value, and run no command that would. For a secrets hit, report `file:line` only.
- This skill never runs `npm run eval:adversarial` or any command that calls a provider. Live evidence is read from the snapshot files.
