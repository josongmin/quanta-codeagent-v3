---
name: loop-on-ci
description: Loop on CI failures — fetch failing-check logs, propose a minimal fix, push, wait for re-run. Triggers on "fix CI", "make CI green", "CI is failing", or after a push whose checks come back red.
userInvocable: true
allowedTools: ["Bash", "Read", "Grep", "Edit"]
category: skill
stability: stable
---

# CI-failure remediation loop

Adapted from Cursor CTK `loop-on-ci` (ADR-0102 absorption batch). The job
is to turn red CI into green with the smallest possible diff per iteration.

## When this skill activates

- The user says "fix CI" / "make CI green" / "CI is failing".
- A `babysit` loop observes a red check after push.
- `gh pr checks` reports `FAILURE` on at least one rollup entry.

## P0 rules

1. **`gh pr checks --json` is the source of truth.** Web UI screenshots /
   memory / "I think it was the linter" are not. Re-fetch each iteration.
2. **One failing check, one minimal patch per iteration.** Bundling fixes
   for multiple unrelated red checks into one commit hides which fix
   worked. Cite which check the patch targets.
3. **`--no-verify` is forbidden.** A failing pre-commit hook = a real
   failure; fix the underlying issue.
4. **Workflow files (`.github/workflows/*`) are off-limits.** Failing CI
   that requires workflow surgery is out of scope; report to user.
5. **Flake gets ONE retry with evidence.** Retry only if (a) the error
   string suggests transience, (b) the same check passes on adjacent
   commits, OR (c) infra status page shows incident. Cite the evidence.
6. **Stop after 3 consecutive same-check failures.** If 3 pushes against
   the same check all fail, you are thrashing — diagnose differently or
   stop and report.

## Procedure

1. **Fetch failing checks.** `gh pr checks <pr> --json
   name,state,conclusion,detailsUrl,workflowRun`. Filter `conclusion =
   FAILURE`.
2. **For ONE failing check, fetch the failing-step log.**
   `gh run view <run-id> --log-failed`. Read the actual assertion / error,
   not the GitHub Actions summary.
3. **Cite the failing assertion** in your reasoning: file:line + the
   error string. NO patch without this citation.
4. **One minimal patch, commit, push.** Commit message: `[ci] fix <check-
   name>: <one-line cause>`. Use the project's `git_commit` tool with
   `mode: "regular"` (still always-confirm tier).
5. **Wait for re-run.** `gh pr checks --watch` polls until the check
   re-runs. If the same check fails the SAME way 3 times in a row, stop.
6. **When all checks green, declare done.** Verify with `gh pr checks
   --json conclusion` showing `SUCCESS` for all entries.

## Outcome enum

- `green` — every check entry conclusion = SUCCESS.
- `partial` — at least one check fixed; others still failing or in flight.
- `thrashing` — same check failed same way 3 times; STOPPED + reported.
- `blocked` — failure requires off-limits surgery (workflow edit, infra
  change, base-branch change); STOPPED + reported.
