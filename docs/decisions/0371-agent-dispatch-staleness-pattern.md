# ADR-0371 — Agent dispatch staleness pattern hardening

Status: Accepted (process-level lesson; codifies an agent prompt template)
Date: 2026-05-28

## Context

R9, R10, R11 sprints each saw at least one worktree agent fail the
"cherry-pick clean" gate because the agent's worktree HEAD was a
strict ancestor of `main` and the agent never consulted main. The
specific failures:

- **R9 W-B (observability metrics)** — fast-forwarded to a 7-day-old
  main, never noticed ADR-0144 `MetricsRegistry` had been refactored.
  Result: built an emitter port that did not match the registry shape.
  Reconciled via cherry-pick conflict resolution.
- **R10 W-B (sqlite backend)** — base commit predated ADR-0345
  `SessionResourceRegistry` port. Agent invented a DB-style port
  (`recordEvent` / `loadEvents`) instead of the resources-getter
  (`getOrCreate` / `peek`). Cherry-pick aborted, R11 re-do required.
- **R11 W-B (slice relocation + histogram)** — base predated ADR-0358
  / ADR-0360 / ADR-0364, all of which import
  `@/agent/codex-r2-metrics`. Agent reported "neither ADR-0358 nor
  ADR-0360 exists on main" (false — both landed). Move was correct
  but the 3 consumer import sites were left unfixed. Cherry-pick
  aborted, R12 re-do.

Pattern confirmed: **worktree dispatch + stale worktree base → agent
makes false negative claims about main state → wasted sprint**.

## Decision

Bake a 5-line "worktree-vs-main reality check" preamble into every
worktree-dispatched agent prompt:

```
## 🛑 Pre-work — staleness verification

Run + REPORT (worktree HEAD, main HEAD, divergence):
  git rev-parse HEAD
  git rev-parse main
  git log --oneline main..HEAD   # worktree-only commits
  git log --oneline HEAD..main   # main-ahead commits (MUST be empty)

If `HEAD..main` is non-empty: `git merge --ff-only main` BEFORE
starting + paste the merge output into the report. Failing to
report = task invalidated.
```

R11 W-A (ADR-0361 sqlite retry) was the first sprint to use this
preamble; the agent reported `83529d6d → 567555a8` ff verbatim and
the cherry-pick was clean. R12 dispatches followed the same pattern.

## Companion lesson — port shape verbatim in the prompt

When the slice depends on a port the agent must consume (rather than
invent), paste the port signature **verbatim** in the prompt + name
the file + name the ADR. This forces the agent into the
`import type { … } from "../path"` path rather than re-derivation.

R11 ADR-0361 verified this: `createSqliteSessionResourceRegistry: (cfg) => SessionResourceRegistry`
in the prompt + return type annotation in the slice meant tsc rejected
any drift at compile time. No same-ID-same-ref invariant violation slipped through.

## Non-goals

- This ADR is **process-level**, not a code change. There is no slice
  / no test / no build artifact to ship. It codifies a prompt template
  the dispatch caller (current sprint operator, or a future automated
  dispatcher) MUST follow.
- An automated `git merge --ff-only main` in the Agent SDK harness
  would be ideal but is out of scope here (SDK-level change).
- Worktree creation policy (fresh-from-main vs whatever-HEAD-is) is
  upstream of this ADR — different SDK versions choose differently.

## Memory cross-reference

- `feedback-worktree-staleness-pattern` (created alongside this ADR) —
  the lesson, in feedback-memory form for future-Claude.
- Sprint memory entries
  [may-27-codex-r9-final-followup-sprint],
  [may-27-codex-r10-codex-cursor-parity-sprint],
  [may-28-codex-r11-sqlite-port-aligned-sprint] — three concrete
  incident reports the lesson is generalised from.
