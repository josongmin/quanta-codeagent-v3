# ADR-0487: force_background — opt-in admission queue + promote-a-waiter for background subagents (C5)

- **상태**: Accepted
- **날짜**: 2026-06-06
- **관련**:
  - ADR-0130 / ADR-0145 (`BackgroundSubagentScheduler` — the `fork`/`poll`/`await` detach surface this slice extends; today over-cap `fork()` THROWS `cap-exceeded` with no wait-state)
  - ADR-0223 (auto-background @2s — the INVERSE vector: push a slow FOREGROUND task into the background; `force_background` pulls a parked BACKGROUND task forward — complementary, not duplicative)
  - `cancel_subagent` control-op family (`src/agent/control-op-handler.ts`) — `force_background` is a sibling typed control-op with the same NO-THROW closed-outcome posture (the parent turn keeps running)
- **참조**:
  - `src/agent/subagent-background.ts` — the 5th `queued` status arm + `ForceBackgroundOutcome` union; the `admissionQueue` (default-OFF) + bounded `maxQueued` (default 64) constructor opts; `drainQueue()` wired into `startRun`'s existing `finally` (after `evictIfOver`) for FIFO auto-drain; `promote()` (deferred half of `fork`'s body); `moveToFront()` (LIFO-at-head, no livelock); `forceBackground(id, {allowBurst?})`; queued-aware `await` loop, `prune`, serialize/hydrate ("lost across restart").
  - `src/agent/control-op-handler.ts` — `forceBackground(scheduler, id, opts)` router helper + `ForceBackgroundControlOutcome` (the 5 producer arms + `scheduler_absent`) + `BackgroundSchedulerSlice` narrow port. NO-THROW (a buggy stub collapses to `not_found`).
  - `src/tool/subagent-bg/force-background.ts` — the model-facing `subagent_force_background` tool (`risk: meta`); `src/tool/subagent-bg/port.ts` — duck-typed `forceBackground` + `SubagentBgForceOutcome`; `src/tool/subagent-bg/index.ts` — `subagentBgTools(scheduler, { forceBackground })` appends the 4th tool ONLY behind the opt-in.
  - Tests: `tests/unit/force-background-queue-hellgate.test.ts` (Phase 1), `tests/unit/force-background-promote-hellgate.test.ts` (Phase 2).
  - Feature catalog: `tools/feature-catalog/features/06-tier1/0487-force-background.yaml`.

## Context

quanta has NO turn-boundary-deferred wait-queue: a background subagent fork
either runs immediately or is rejected at `maxConcurrent` (`fork()` throws
`cap-exceeded`). Cursor's `force_background_subagent` "run this queued task now"
affordance presupposes a waiting state to promote OUT of. So a faithful
absorption is two parts: (Phase 1) introduce the missing `queued` admission
state; (Phase 2) the promoter.

## Decision

**Phase 1 — admission queue (opt-in, default-OFF).** A 5th `queued` status. When
`fork()` would exceed `maxConcurrent` AND `admissionQueue` is on, the spec is
parked as a `queued` handle (FIFO, bounded by `maxQueued`) instead of throwing.
The queue auto-drains (oldest-first) on each slot-free at the EXISTING
`finally → evictIfOver` hook — no new pump. Default-OFF ⇒ `fork()` throws on cap
exactly as before (byte-identical); no `queued` entry can exist.

**Phase 2 — the promoter.** A `forceBackground(id, {allowBurst?})` method + a
`force_background` control-op + a `subagent_force_background` meta tool that
promote a `queued` handle to run-now (free slot, or +1 burst under explicit
`allowBurst`) or to the FIFO head. Closed NO-THROW outcome union mirroring
`cancel_subagent`.

## Fail-closed invariants

- **Bounded queue** — `maxQueued` (default 64); over it `fork()` throws typed
  `queue-full`. No unbounded growth (DoS).
- **Burst is +1, never +2** (R2) — a second `allowBurst` while already over-cap
  degrades to `moved_to_front`. The cap is the resource ceiling; burst is a
  one-slot courtesy, not a bypass.
- **No silent re-run across restart** (R5) — a `queued` entry has no in-flight
  promise; it reborn as `failed` "lost across restart" on hydrate, like a
  `running` entry. A side-effecting parked task is never double-executed.
- **No livelock** (R4) — `moved_to_front` is strictly LIFO-at-head; `prune`
  drops `queued` entries older than `maxAgeMs` (stale parked task).

## Default posture

OFF, byte-identical. Absent `admissionQueue` the scheduler is unchanged for
every existing caller; the meta tool is appended only behind
`{ forceBackground: true }`; `forceBackground` returns `queue_disabled`. The
submission-op union arm, the env knob wiring at the composition root
(`QUANTA_SUBAGENT_QUEUE` / `QUANTA_FORCE_BACKGROUND`), the manifest row, and the
`MUTATING_TOOL_TABLE` entry are the host-side caller wave and land separately.

## ROI

LOW (honest, RFC §8 R1). The common case is covered by Phase-1 FIFO auto-drain
(FIFO > throw-on-cap is a real UX win for its own sake); the promoter earns its
keep only at-cap when a parked task matters more than the running ones.
