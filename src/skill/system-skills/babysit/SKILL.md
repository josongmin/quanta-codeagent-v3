---
name: babysit
description: Keep a PR merge-ready by reacting to CI failures and review comments in a loop. Triggers when the user asks to "babysit" a PR, "merge when green", "land this PR", "keep checking until it merges", or shares a PR URL with intent to ship.
userInvocable: true
allowedTools:
  - Bash
  - Read
  - Grep
  - Edit
category: skill
stability: stable
tools:
  - Bash
  - Read
  - Grep
  - Edit
---

# PR babysit

Adapted from Cursor CTK `babysit` (ADR-0102 absorption batch). The job is to
shepherd ONE pull request from "open" to "merged" without thrashing.

## When this skill activates

- The user names a PR and says "babysit" / "watch" / "merge when green" / "land this".
- The user shares a PR URL with verbs like "ship it", "get this merged".
- An ongoing session asks you to retry / re-push after a CI failure.

If none of these apply, do not silently pivot a normal task into a babysit.

## P0 rules

1. **`gh pr checks` is the source of truth.** Do not infer CI status from PR
   description, GitHub web UI screenshots, or memory. Only the JSON from
   `gh pr checks <pr> --json` proves green/red.
2. **Intent conflict ⇒ abort + ask.** If the PR diverges from the user's
   stated intent (e.g. the PR includes refactors they did not request), STOP
   and ask. Do not "fix it up" silently.
3. **Never modify CI workflow files (`.github/workflows/*`).** A failing CI
   that requires workflow surgery to pass is out of scope; report it.
4. **Never use `--no-verify`.** A failing pre-commit hook is a real failure;
   diagnose and fix the underlying cause.
5. **Unrelated red checks are not yours.** If a CI failure is in a check
   that the PR does not touch (e.g. unrelated flaky e2e), prefer to MERGE
   into main and re-run rather than to investigate the unrelated lane.
6. **Flake gets ONE retry with evidence.** A single retry of a known-flake
   check is acceptable; cite the evidence (same error string, transient
   timing, infra-side issue) explicitly.

## Procedure

1. **Restate the intent.** What is the PR supposed to ship? Quote the PR
   description or the user message — do not paraphrase.
2. **Fetch the current state.** `gh pr view <pr> --json state,mergeable,
   reviewDecision,statusCheckRollup,headRefName,baseRefName,title,url`.
3. **Read the failing-check logs ONLY for checks touching this PR.**
   `gh run view <run-id> --log-failed`. Cite the failing assertion + file:line
   in your reasoning before any edit.
4. **One minimal patch per loop.** Make the smallest possible fix, commit,
   push. Do not roll multiple unrelated fixes into one commit.
5. **Wait for checks to re-run before declaring done.** A pushed commit that
   has not yet run CI is not green. Use `gh pr checks --watch` (or poll).
6. **Stop on intent conflict, hard block, or merge success.** Three terminal
   states: (a) merged, (b) intent diverged → ask user, (c) hard block (PR
   needs base-branch changes, requires human review, etc.) → report and stop.

## Outcome enum

- `merged` — `gh pr view` shows `state: MERGED`, `mergeable: MERGED`.
- `awaiting-review` — checks green but `reviewDecision != APPROVED`.
- `blocked` — at least one check red AND no plausible self-fix; the loop
  cannot proceed without the user.
- `intent-conflict` — the PR has drifted from user intent; STOPPED + asked.

The string `complete` is forbidden until the PR is actually `merged`.

## Manual-resume via the proactive reactor (ADR-0132)

When `QUANTA_PROACTIVE_REACTOR=1` is set, the CI / PR-comment watchers
(`src/reactor/`) can wake the agent autonomously with a `ci_completion` or
`pr_comment` trigger. The `/babysit` slash command remains the **manual
fallback**: it maps to the same `TriggerReason` union member
(`manual_resume`), so the simulated-message audit suffix
(`[reason=<r> evidence=<kind>=<value>]`) is uniform whether the wake came
from a cron poll or from a human typing `/babysit`. Babysit's loop body is
unchanged — only the entry seam differs.

The reactor's three hard guards (env flag, 30s quiet window, prior turn
outcome ≠ `"fail"`) apply to BOTH paths. A manual `/babysit` invocation
inside the quiet window is queued by the surface, not silently dropped.
