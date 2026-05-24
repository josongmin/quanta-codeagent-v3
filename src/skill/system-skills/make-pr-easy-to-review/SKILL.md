---
name: make-pr-easy-to-review
description: Audit and clean up a PR before review — noisy commits, stale description, unrelated files, mixed mechanical+logic changes. Triggers on "clean up this PR", "make this PR easier to review", "tidy commits", or before opening for review.
userInvocable: true
allowedTools: ["Bash", "Read", "Grep", "Edit"]
category: skill
stability: stable
---

# Pre-review PR cleanup

Adapted from Cursor CTK `make-pr-easy-to-review` (ADR-0102 absorption
batch). The job is to reduce reviewer load — detect the four canonical
review-friction signals and propose fixes.

## When this skill activates

- The user says "clean up this PR" / "easier to review" / "tidy commits".
- A PR has been open for >24h with no reviewer engagement.
- A `babysit` loop is `awaiting-review` and the PR has obvious friction.

## P0 rules — the four detectors

1. **Noisy commits.** `git log --oneline base..HEAD` shows >10 commits OR
   commits like `fix typo`, `wip`, `address review`, `final fix`. Reviewer
   has to mentally collapse them. **Fix:** propose a squash plan (preserve
   atomic logic, collapse fixups).
2. **Stale description.** PR description does not match the current diff
   (e.g. talks about feature X but diff also touches Y). Fetched via
   `gh pr view --json body,title`. **Fix:** propose an updated description
   that matches the actual diff.
3. **Unrelated files.** Files in the diff that have NO relation to the
   stated intent (formatting noise, dependency bumps mixed in, unrelated
   refactors). Detect via reading the PR description's stated scope and
   cross-referencing the file list. **Fix:** propose splitting the
   unrelated files into a follow-up PR.
4. **Mixed mechanical + logic.** A single commit (or PR) contains BOTH
   mechanical changes (rename, reformat, move file) AND logic changes
   (behavior, contract). The mechanical noise hides the logic. **Fix:**
   propose splitting into two commits — mechanical first, logic second.

## Procedure

1. **Fetch the PR state.** `gh pr view --json title,body,baseRefName,
   headRefName,url`; `gh pr diff > /tmp/pr.diff`; `git log --oneline
   <base>..HEAD`.
2. **Run the four detectors in order.** For each, output ONE block:
   ```
   ## <detector-name>
     status:  triggered | clean
     evidence: <file:line | commit sha | diff hunk>
     proposed fix: <one sentence>
   ```
3. **Do NOT auto-apply fixes.** The user must approve each fix
   individually — squash plans, description rewrites, and file splits all
   require explicit consent.
4. **Report in summary form.** Four detector blocks + one terminal
   verdict.

## Outcome enum

- `clean` — all four detectors cleared; PR is review-ready.
- `friction` — at least one detector triggered; fixes proposed but not
  applied. User decides per detector.
- `partial-applied` — user accepted some fixes and they landed; others
  declined.
