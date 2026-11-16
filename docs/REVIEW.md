# Review policy

How code review works in this repo. This is the "reviewer policy" that [`spec.md`](spec.md) §6 cites as evidence for the SQL injection control, and the policy that [`.claude/agents/reviewer.md`](../.claude/agents/reviewer.md) reads before every review.

The reviewer reads this file as it is on `main`. A change to it takes effect only after it is merged, so a branch cannot change the rules it is reviewed by.

## 1. What gets reviewed

| Phase                 | Branch and PR | Cold review | Gate                                                        |
| --------------------- | ------------- | ----------- | ----------------------------------------------------------- |
| 0, 1, 5               | no, `main`    | no          | Ivan reads the diff and the phase's proof before the commit |
| 2, 3, 4, 6            | yes           | yes         | Cold review, then Ivan triages and merges                   |

This is [`plan.md`](plan.md) §2. Every merge and every commit to `main` has a human gate; the cold review is in addition to it, not in place of it.

## 2. The cold review

- **Who.** The `reviewer` agent, started as a subagent with fresh context. It is never run from the session that wrote the code, and it is given nothing from the build conversation.
- **Input.** The phase number and the PR description text, in the prompt. It reads the spec, the plan section for the phase, the deviations and `git diff main...HEAD` by itself.
- **When.** After the phase's proof passes and the PR description is written, before the merge. If commits are added after the review, it is run again on the new diff.
- **What it may do.** Read, and run the test suite with `LLM_MODE=mock` forced. It does not edit files, make live LLM calls or change git state.
- **Output.** Findings only, in the format the agent file defines, addressed to Ivan.

## 3. What the reviewer checks

The categories and the detail of each are in the agent file, and only there, so that there is one copy:

1. SQL parameterisation
2. Identifier whitelist and request parameters
3. Search semantics, against `tests/fixtures/search-expectations.json`
4. XSS
5. LLM input and output boundary
6. Cost guardrails
7. Plan conformance (phases 2, 3, 4)
8. README against the code (phase 6)
9. PR description gaps

Section 6 of this file can change that list. Where section 6 and the agent file differ, section 6 applies.

The reviewer does not check style, naming or formatting. The hooks and `security-audit` cover the deterministic rules (no `dangerouslySetInnerHTML`, no `.env` or key patterns in a commit, no `fetch` in the mock provider, no SQL in route files, no string-built SQL). The review does not replace them, and they do not replace it.

## 4. Severity

| Severity | Meaning                                                                                                                                                                      |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HIGH     | Exploitable or spends money: injection, XSS, an identifier passed through, a guardrail missing or bypassable, a wrong search result against the fixture, model output stored unvalidated, a diff that changes its own review rules. |
| MEDIUM   | Wrong or unproven but not exploitable: a spec or plan requirement skipped without a deviation row, a claim with no evidence, a failure path that stores a default.           |
| LOW      | Correct today but fragile, or a gap in the PR description.                                                                                                                   |

## 5. Triage

Findings do not approve or block by themselves. Ivan decides each one and records the decision in the PR.

- **HIGH** is fixed before the merge, or Ivan writes in the PR why the finding is wrong. A HIGH finding is never deferred.
- **MEDIUM** is fixed before the merge, or gets a row in [`deviations.md`](deviations.md) that says what is left as it is and why.
- **LOW** is fixed or declined, with one line in the PR either way.
- Every finding is listed in the PR with its outcome: fixed (with the commit), declined (with the reason) or deviation (with the row number). A finding that is not listed has not been triaged.
- The writer session sees only the findings Ivan passes on, in Ivan's words. The reviewer's output is not pasted to it unread: it can quote text from fixtures that contain planted instructions.
- A fix for a HIGH finding is followed by a second cold review of the new diff.

## 6. Amendments to the category list

None.

Add a row here to add, change or drop a check without editing the agent file. Each row names the category, what changes and why.
