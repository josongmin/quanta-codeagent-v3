---
name: review-and-ship
description: Complete ship loop — review the change, run tests, commit, push, open PR. Triggers on "review and ship", "test then PR", "verify and merge", or when a user has staged changes and wants to ship them.
userInvocable: true
allowedTools: ["Bash", "Read", "Grep", "Edit"]
category: skill
stability: stable
---

# Review + test + commit + PR (combined ship)

Adapted from Cursor CTK `review-and-ship` (ADR-0102 absorption batch).
Combines self-review + verification + commit + PR into one orchestrated
flow. Composes `pr-review-canvas` (review), `new-branch-and-pr` (ship).

## When this skill activates

- The user says "review and ship" / "test then PR" / "verify and merge".
- A change is complete in the working tree and the user wants the full
  release flow without naming each step.

## P0 rules

1. **Review BEFORE commit.** Self-review is the cheapest defect-catch
   surface; skip it and ship the easy-to-catch bug.
2. **Tests gate the commit.** A failing test stops the flow — do not
   commit, do not push, do not open a PR. Fix the test or the code,
   then restart from step 1.
3. **Explicit user consent for each mutation.** This skill performs
   commits and pushes; user activated by name, but each gated tool call
   still surfaces a confirmation.
4. **No `--no-verify`, no `--force`, no `--amend`.** All the destructive
   git verbatim bans (Git posture system prompt) apply.
5. **One change, one PR.** If the working tree has UNRELATED edits,
   stop and ask the user — do not bundle.

## Procedure

1. **Self-review** (delegate to `pr-review-canvas`-style classification
   on the WORKING TREE diff, not on a PR). Output the same four
   sections: logic / moved / mechanical / risks. If `risks` is
   non-empty, surface them BEFORE proceeding.
2. **Verify** with the project's test rail. `bun run typecheck` first
   (cheap), then `bun test` (slower). Cite the exact rail + verdict.
3. **Diff sanity-check.** `git status` — confirm only the files you
   reviewed are staged. Any extra ⇒ ask the user.
4. **Branch + commit + push** (delegate to `new-branch-and-pr`-style
   sequence). Branch `quanta/<short>`, commit `<imperative>: <subject>`,
   push with `-u`.
5. **PR open with verification report in body.** Body MUST include
   what changed and the verification result (rail + verdict + green/red).
6. **Report the PR URL** as the deliverable.

## Outcome enum

- `pr-opened` — PR URL emitted with verification report attached.
- `stopped-at-review` — self-review surfaced a risk that the user must
  address before shipping.
- `stopped-at-verify` — verification failed (test red / typecheck red);
  do not commit until fixed.
- `stopped-at-confirm` — user declined a confirmation prompt.
