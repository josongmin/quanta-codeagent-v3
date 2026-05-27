# ADR-0389 — Worktree-agent API-instability retry harness (process)

**Status:** Accepted (2026-05-28)
**Type:** Process / lesson capture (no code change in this ADR)
**Scope:** Worktree-isolated SOTA++ agents dispatched via the Agent
tool with `isolation: "worktree"`.
**Default-OFF:** N/A — process policy only.

## Context

Across the codex-r2 R9 + R10 + R14 sprint cycles, **four** worktree
agents lost work to API `ConnectionRefused` errors mid-turn:

| Sprint | Agent | Tool-use envelope | Outcome              |
|--------|-------|-------------------|----------------------|
| R9     | W-C   | ~48 uses lost     | Salvaged on main     |
| R9     | W-D   | ~48 uses lost     | Salvaged on main     |
| R14    | W-A   | ~48 uses lost     | Reached ff stage, salvaged |
| R14    | W-B   | ~48 uses lost     | Reached ff stage, salvaged |

In every case the agent had reached at least the "RED hellgate +
partial implementation" stage before the connection died. The smallest
ADRs (ADR-0378 + ADR-0379 in R14) ended up landing **direct to main**
rather than waiting for a second worktree dispatch — faster and
guaranteed-complete, because the work envelope fit within the main
session's tool budget.

This ADR captures the process lesson: **worktree dispatch is high-ROI
for parallelizable work but its loss rate is non-trivial. Size the
dispatch envelope accordingly, and pre-decide a salvage path.**

## Decision (process)

For every `isolation: "worktree"` dispatch:

### 1. Size the envelope first

Pre-estimate the agent's tool-use budget. If the work fits in
**< 30 tool uses** of incremental progress, do NOT dispatch a
worktree — execute on main. The worktree overhead (cherry-pick
reconcile + integrated verify) eats the parallelism benefit when
the work envelope is small.

### 2. Land smallest items main-direct

When a sprint has 5+ follow-ups of mixed size, sort by tool-budget:

- **Smallest 1–2** → main-direct (no worktree dispatch).
- **Mid-size 3–4** → worktree dispatch (parallel).
- **Largest 1** → worktree dispatch with extra context budget.

R14 used this split: ADR-0378 + ADR-0379 (smallest) landed direct;
ADR-0380/0381/0382 (larger) deferred to R15 worktree dispatch.
R15 followed the pattern: ADR-0384/0385/0386/0387 in worktrees;
ADR-0388 + ADR-0389 direct on main (markdown-only).

### 3. Pre-write a salvage prompt

Before dispatching, draft the "salvage on main" version of the same
work. If a worktree dies, paste the salvage prompt and finish on
main without re-planning. The salvage envelope is typically 30–50%
of the worktree envelope because the main session already has the
context loaded.

### 4. Do NOT retry the same worktree

Once a worktree agent loses connection, the partial state in that
worktree is usually **not recoverable** — the agent may have:

- Created uncommitted changes (lost when the worktree is GC'd).
- Made the wrong import (caught later, no time to fix).
- Skipped the staleness preamble (per ADR-0371).

Salvage on main is faster than redispatch + verify-the-recovery.

### 5. Track the loss rate

Per-sprint, log the worktree:dispatched : worktree:succeeded ratio.
If the success rate drops below 75% over a rolling 10-dispatch
window, pause worktree dispatches and execute the sprint on main
until the upstream API stabilizes (Anthropic console + status page
typically explain the dip).

## What this ADR does NOT do

- **No automated retry harness.** Building a "retry the worktree on
  ConnectionRefused" wrapper was considered and rejected — the agent
  state at the point of failure is non-deterministic (in-flight edits,
  cherry-pick state, etc.). Human-in-the-loop salvage is more
  reliable than automated retry.
- **No fallback model.** Switching the worktree agent to a smaller
  model on retry would change the work envelope (smaller models
  produce different code quality on SOTA++ tasks). Pause-and-resume
  is cleaner than fall-back-and-degrade.
- **No upstream-status polling.** The agent does not poll Anthropic's
  status page. The user is the source of truth for "should I keep
  dispatching."

## Observed signals (when to pause worktree dispatch)

- 2+ consecutive `ConnectionRefused` failures in a single sprint.
- Tool-use latency 3x normal in the main session (often precedes
  upstream-API trouble on worktrees).
- Anthropic status page red.

## References

- ADR-0371 — Worktree-HEAD staleness preamble (the procedural fix
  for a *different* worktree-agent failure mode — silent staleness
  rather than connection loss).
- Memory: `worktree-node-modules-hazard` — separate worktree failure
  mode (symlink interference).
- Memory: `feedback_worktree_staleness_pattern` — codifies the
  staleness preamble as agent-prompt boilerplate.
