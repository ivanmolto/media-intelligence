---
name: wrap-session
description: End-of-session routine — run the verification command, flag forbidden files and keys, check deviations, owed skills and the branch, propose a commit message in the project format, scan the session log for keys before the transcript is exported, and remind about push. Use at the end of every working session before anything is committed.
---

# wrap-session

Everything here is proposed, not done: no commit, no revert, no file deletion, no push unless a human says to.

## Steps

1. **Checks.** Run the verification command that `CLAUDE.md` names. If `CLAUDE.md` is missing or names none, say so and run `npm run typecheck && npm test`, leaving out any script `package.json` does not define and naming what was left out.
   - The tests need the compose `db` service: Vitest's global setup creates `media_test`. If the failure is a connection error, report "database not up" and the command to start it (`docker compose up -d db`), not a test failure.
   - If anything fails, report the output and stop — no commit proposal.
   - Skip this step only if there is nothing to run: no `package.json` yet, or every changed path is under `docs/` or `.claude/`. Say that it was skipped and why.

2. **Forbidden files.** Run `git status --porcelain -uall` (`-uall` lists files inside untracked directories; without it a `scripts/.env` hides behind `?? scripts/`). Report each hit as BLOCK with its reason and the proposed fix:

   | Path matches | Reason | Proposed fix |
   | --- | --- | --- |
   | `.env`, `.env.*` at any depth (except `.env.example`) | secret | unstage; add to `.gitignore` |
   | `docs/intent.md`, `docs/spec.md`, `docs/plan.md` | frozen — changes go in `docs/deviations.md` | revert the edit; add the deviation row |

   The frozen check also covers commits made this session that are not pushed yet:
   - `git log --name-only --format= @{upstream}..HEAD`; if the branch has no upstream, `main..HEAD`.
   - On `main` with no upstream there is nothing to compare against: say "unpushed-commit check not run".
   - A frozen file in an unpushed commit is BLOCK. The proposed fix is a new commit that restores the file, plus the deviation row — never an amend or a rebase.

   Then scan **contents** for keys, using the project's one pattern list (the same file the pre-commit hook and `security-audit` read). The commands end in `cut` so that only `file:line` is printed. Do not run them without it: the output of this session is the transcript that gets committed.
   - changed tracked files: `git diff HEAD --name-only --diff-filter=d -z | xargs -0 grep -HnIE -f scripts/secret-patterns.txt | cut -d: -f1,2`
   - untracked files: `git ls-files -o --exclude-standard -z | xargs -0 grep -HnIE -f scripts/secret-patterns.txt | cut -d: -f1,2`

   Any hit is BLOCK (reason: secret; proposed fix: remove it and rotate the key). Do not open the file at that line to look. If `scripts/secret-patterns.txt` does not exist yet, say "key scan not run" — do not substitute patterns of your own.

   `docs/ai-transcript/` is **not** blocked: the plan commits each phase's transcript in that phase's PR or final commit. Earlier transcripts are covered by the key scan above; this session's is scanned in step 8, before it is exported.

3. **Deviations.** Work out which phase this session belongs to from `docs/plan.md` §3 and the matching `docs/phase-N-notes.md`. Compare the diff with that phase's file list, steps and proof. If the work departed from the plan or the spec and `docs/deviations.md` has no new row for it, say so and propose the row in the table's own columns: `#`, `Date`, `Stage`, `The document says`, `What changes`, `Why`.

4. **Skills owed.** Read the `description` of each skill under `.claude/skills/` and list those whose trigger matches the changed paths. For each, say whether it was run this session and what it reported. A skill that is owed and was not run is stated in the wrap-up; it does not block the proposal, but the commit body or PR must not claim what that skill would have shown.

5. **Branch.** State the current branch. Compare it with `docs/plan.md` §2 for this phase (a branch and PR, or directly on `main`). A mismatch is a finding: say so before the commit proposal.

6. **Phase notes.** If the diff completes the phase — its proof in `docs/plan.md` §3 is met — the phase's `docs/phase-N-notes.md` says to delete it. Propose the deletion as part of this commit, and name any note in it that is still true and has no home in `deviations.md` or the README.

7. **Commit message.** Propose **one** message:
   - `type(scope): what decision landed`
   - for fixes: `fix(scope): what was wrong — how it showed`
   - `type` is one of `feat`, `fix`, `test`, `docs`, `refactor`, `chore`. `scope` is the area touched (`search`, `enrich`, `articles`, `ui`, `db`, `skills`…); omit it for a docs-only commit, as the history does (`docs: add frozen plan`).
   - body: 1–3 lines on why, if not obvious
   - no attribution trailers (`Co-Authored-By`, "Generated with") — the history has none.
   - name the files that go in it, including the transcript path that step 8 is about to create.

8. **Transcript: scan, then export.** The session is already on disk as a log, so it is scanned before anything is written into the repo.
   1. Print a marker, as its own command: `echo "wrap-marker-$(date +%s)-$RANDOM"`.
   2. In a second command, find the log that contains it. With two sessions open, the newest file is not necessarily this one:
      `grep -l "<marker>" "$HOME/.claude/projects/$(pwd | sed 's#[/.]#-#g')"/*.jsonl`
   3. Count matches in that file — a count only, never the lines:
      `grep -cE -f scripts/secret-patterns.txt <log>`
      - `0`: continue to the export.
      - Anything else: BLOCK. Say the count and do **not** print the export command. The key is in this session; the proposed fix is to rotate it and not to export this session as it is.
   4. On `0`, list `docs/ai-transcript/` and take the next two-digit number (`01` if the directory is empty or missing); suggest a short kebab-case topic. Print:

      ```
      Human, the session log is clean. Export the transcript:
        /export docs/ai-transcript/NN-<topic>.md
      ```

      No reply is needed. The transcript contains the whole session, wrap-up included.

   Limits, to state when they apply:
   - If exactly one log is not found in step 2, or `scripts/secret-patterns.txt` does not exist, say "pre-export scan not run" and print the export command with that warning. Then, if the human says "exported", scan the exported file with line numbers only: `grep -nIE -f scripts/secret-patterns.txt docs/ai-transcript/NN-<topic>.md | cut -d: -f1`.
   - The log is JSON, so quotes and newlines in it are escaped. Patterns for key formats match the same; a pattern that depends on a literal quote or a line break may not. The pre-commit hook scans the exported file itself and is the backstop.
   - The log is outside the repo. Read nothing from it except the two greps above.

9. **Reminder.** Print:

   ```
   Human, before closing this session:
     git push   (I don't push)
   ```

## Rules

- Propose; do not run `git commit`, revert a file or delete a file unless a human says to.
- One commit per slice. A slice is one change that could be reverted on its own: one decision, inside one phase, with its tests and its deviation row if it has one. If the diff spans two slices, say so and propose two messages, naming which files go in each.
- Never propose `--amend`, `--force` or a rebase.
- Print no secret value, and run no command that would.
