---
name: pr-review-canvas
description: Review a PR with moved-code detection — separate genuine logic changes from pure code MOVEMENT (function relocated, file renamed) so the reviewer sees signal, not noise. Triggers on "review this PR", "audit this PR", "what changed", "is this safe to merge".
userInvocable: true
allowedTools: ["Bash", "Read", "Grep"]
category: skill
stability: stable
---

# PR review canvas — moved-code detection

Adapted from Cursor CTK `pr-review-canvas` (ADR-0102 absorption batch).
The killer feature: a normal `git diff` displays a function move as
`delete from A + add to B`, which reviewers misread as TWO changes. This
skill separates that out — moved code in its own category, real changes
get the focus.

## When this skill activates

- The user says "review this PR" / "audit this PR" / "is this safe".
- A user shares a PR URL with intent to inspect changes.
- A `babysit` loop is `awaiting-review` and needs a first-pass review.

## P0 rules

1. **Move detection is mandatory.** Every block in the diff is classified
   as `logic` | `mechanical` | `moved` BEFORE the review starts. Without
   the classification, the reviewer drowns in noise.
2. **Moved code is INVISIBLE by default.** If the function body is
   byte-identical between A and B (modulo whitespace), the move adds no
   risk — surface it as a one-liner ("moved foo() A:42 → B:7"), not as
   a full diff hunk.
3. **Mechanical changes get a one-liner too.** Renames (variable, file),
   pure reformatting, import-order shuffles. Visible in the summary, not
   in the detailed review.
4. **Logic changes get the FULL review treatment.** Every logic block is
   read with: what changed, why, what could break, what to test.
5. **Cite file:line on every finding.** No vague claims.

## Procedure

1. **Fetch the diff.** `gh pr diff <pr> > /tmp/pr.diff` (or `git diff
   base...HEAD` for a local branch).
2. **Build the file inventory.** For each file in the diff, classify the
   whole-file outcome:
   - `added` — new file, all logic, full review.
   - `deleted` — file removed; check for orphans (imports still pointing
     here, tests for it).
   - `renamed` — git's rename detection (`git diff -M`); body unchanged
     ⇒ note the rename, no body review needed.
   - `modified` — block-by-block classification (see step 3).
3. **For each `modified` file, classify EACH hunk.** A hunk is `moved`
   when its `-` lines match `+` lines elsewhere in the SAME PR (use
   `git diff --color-moved=zebra` to surface). `mechanical` if it's pure
   rename/reformat. Otherwise `logic`.
4. **Report in four sections:**
   - **Logic changes** (the focus): per file, hunks with what / why /
     risk / test plan.
   - **Moved code** (one-liners): "moved <symbol> from A:line → B:line".
   - **Mechanical** (one-liners): "renamed <old> → <new>" / "reformatted
     <file>".
   - **Risks** (cross-cutting): potential regressions, missing tests,
     unrelated changes.
5. **Final verdict.** `LGTM` / `request-changes` / `needs-more-context`.

## Outcome enum

- `lgtm` — logic changes are coherent, tested, low risk.
- `request-changes` — at least one logic change has a named risk that
  needs addressing.
- `needs-more-context` — cannot review confidently without more info
  (missing test plan, unclear intent, etc.).
