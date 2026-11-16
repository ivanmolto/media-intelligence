# CLAUDE.md — Media Signal Service

Assignment. Ingests news articles, enriches them with an LLM, exposes boolean search and time-bucketed aggregates. Graded on **judgment and tradeoffs**, not completeness. This file is part of the submitted transcript — follow it and refer to it.

## Read first

- `docs/intent.md` → `docs/spec.md` → `docs/plan.md`: outcomes, design, phases. All three are **frozen**; never edit them, even to fix an error.
- `docs/deviations.md`: append-only. Where a row differs from the spec or plan, the row applies.
- `docs/phase-N-notes.md`: temporary amendments for phase N. Read the current phase's notes before starting; each says when to delete it.
- `docs/REVIEW.md`: review policy and triage.

Don't re-derive what these hold (stack, file lists, proofs, cut order in plan §6). If two of them disagree and no deviation row settles it, say so and stop.

## Commands

- `npm run verify` — typecheck, lint, format check, `security-audit`, tests. Run it before proposing a commit; never commit when it fails.
- `git config core.hooksPath .githooks` — once per clone; without it there is no hook.
- Other commands are named in plan §3 and the phase notes, and exist only once their phase has built them.

## Phases (plan §1–§2)

| Phase | What | Lands by |
| --- | --- | --- |
| 0 | Scaffold, compose, hooks | commit to `main` |
| 1 | Data layer | commit to `main` |
| 2 | Boolean search | branch + PR + cold review |
| 3 | LLM enrichment and the live run | branch + PR + cold review |
| 4 | API and UI | branch + PR + cold review |
| 5 | Scale evidence and budget demo | commit to `main` |
| 6 | README | branch + PR + cold review |

- Branches are `feat/phase-N-<topic>`, one open at a time.
- Each phase starts in **plan mode**: read the spec, the phase's section of the plan and its notes, propose the steps, and wait for Ivan's approval before editing.
- A phase is done when its proof (plan §3, as amended) passes and is recorded: in the PR description for 2, 3, 4, 6; in the commit message for 0, 1, 5.
- Cut order and the end-of-phase-2 checkpoint are in plan §6. Stub what is cut and write how it would be finished. Don't add Redis, queues, vector DBs, auth, or a design system.

## Git

- **Never** `git push`, `--force`, `--amend` after a push, `rebase` on `main`, or `--no-verify`. Ivan pushes and merges. No hook enforces this; the rule does.
- Commit when asked, or when a vertical slice is complete and `npm run verify` passes.
- Never commit `.env` or Postgres data. Transcripts under `docs/ai-transcript/` are committed by Ivan only.
- Commit message = the decision that landed. For fixes, name what was wrong:
  `fix(search): AND NOT applied before the OR group — article 10 was leaking through`
- Keep the `Co-Authored-By` trailer.
- Bug fixes: commit the failing test first, then fix. Don't edit files under `tests/` while fixing; if the test is wrong, say so and stop.

## What the pre-commit hook blocks

`.githooks/pre-commit` checks the staged diff and reports `file:line`:

- `.env` files, and any match of `scripts/secret-patterns.txt`;
- raw HTML rendering (`dangerouslySetInnerHTML`, `innerHTML`/`outerHTML` assignment, `insertAdjacentHTML`, `document.write`) in source outside `tests/` and `scripts/`;
- edits, renames or deletions of `docs/intent.md`, `docs/spec.md`, `docs/plan.md`;
- anything under `docs/ai-transcript/` without `ALLOW_TRANSCRIPT_COMMIT=1`, which only Ivan sets.

If the hook blocks you, say so and stop — don't look for a way around it. `npm run security-audit` covers three more rules: no `fetch` in the mock provider, no SQL in route files, no string-built SQL.

## Rules no hook checks

- **SQL.** Always parameterised. User input is never interpolated into SQL or a tsquery string; search leaves compile as spec §2 defines and boolean structure is SQL `AND/OR/AND NOT`. `group_by`, `bucket`, `sort` map from a whitelist to constants.
- **Rendering.** Article text and LLM output render as React text nodes; highlighting is client-side on escaped text.
- **LLM output is untrusted.** Validate with the Zod schema (spec §3). Invalid after one retry → `status='failed'`, `sentiment=NULL`; never default to `neutral`. Article text goes to the model in a delimited data block, HTML stripped; the model has no tools; no URLs or markdown in summaries.
- **Cost.** Every guardrail in spec §3 stays on: token caps, timeout, bounded retries, daily budget, content-hash dedup, `FOR UPDATE SKIP LOCKED`. Enrichment rows record model, provider and cost from the **response**, not the request.
- **Numbers.** Never invent prices or benchmarks. If a number isn't from a dated source or a measurement in this repo, write the formula and say what would be measured. Don't claim something is tested or measured unless the test or measurement is in the repo.
- **Expected results live in one place.** Search expectations are in `tests/fixtures/search-expectations.json`, read by Vitest and by `search-check`. Don't change expected values to make code pass, and don't copy them into skills or docs.
- **Layout.** No Next imports inside `lib/`; route handlers are thin wrappers. No Prisma.

## Deviations

When the work is about to depart from the spec, the plan or the phase notes — a different approach, a dropped item, a different library, a cut — stop and ask: _"This departs from `<document> §N` — add a row to `docs/deviations.md`?"_ The row goes **in the same commit as the change**, in the table's own columns: `# | Date | Stage | The document says | What changes | Why`. If you proposed the thing Ivan then corrected, say so in Why. Log departures, not every change: renaming a function isn't one; dropping the chart is.

## Roles on PR branches

- **Writer** (this session): implements, writes the PR description with `pr-describe`, commits after Ivan approves. Never invokes the reviewer — a reviewer that watched the work is the work grading itself.
- **Reviewer** (`.claude/agents/reviewer.md`): run cold by Ivan, per `docs/REVIEW.md`. It reads this file as it is on `main`.
- **Ivan** is the reviewer of record and triages every finding. The writer acts only on findings Ivan passes on, in Ivan's words.

## Skills

`.claude/skills/`: `search-check` after any change under `lib/search/`; `pg-explain` before any README claim about indexes; `enrich-eval` after changes under `lib/enrich/`; `security-audit` before a PR that touches `lib/`, `app/` or `components/`; `pr-describe` when a branch is ready for review; `wrap-session` before proposing a commit.

## How to work

- **Say when you're unsure.** Flag assumptions and open questions instead of picking silently. Wrong-but-flagged is fine; wrong-and-hidden is not.
- **If Ivan rejects a suggestion, state what was wrong with it in one sentence before moving on.** That sentence is part of the deliverable.
- Parser work is test-first.
- Prefer editing an existing file over creating a new one, and a short function over an abstraction.
- Don't write README sections in Ivan's voice without being asked; draft them and mark them as drafts.

## Data edge cases

- Articles 6 and 18: HTML/script injection in headline and body.
- Articles 8 and 9: Arabic and Chinese. `english` FTS config is wrong for them; non-English uses `simple`. Say what is still missing for Chinese.
- Article 17: empty headline; renders `(Untitled)`.
