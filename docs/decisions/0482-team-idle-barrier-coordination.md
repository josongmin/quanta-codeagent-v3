# ADR-0482: Team-idle barrier coordination — idle-beacon fan-in over the side-agent daemon team (Capability C)

- **상태**: Accepted
- **날짜**: 2026-06-06
- **관련**:
  - ADR-0479 (team DAG coordination — Capability A of the same multi-agent plan; the DAG orders WORK across a flat batch, this ADR fans IN when the resident team quiesces)
  - ADR-0480 (team broker coordination — Capability B; the sibling default-OFF coordination slice over the same `src/subagent/coordination/**` fence)
  - ADR-0130 (subagent fork — the bounded one-shot pass each side-agent wake reuses as its runner)
  - ADR-0161 (scheduled agent — drives the MAIN loop on an RRULE; a side-agent daemon is the orthogonal resident-team substrate this barrier fans in over)
  - ADR-0416 (subagent mailbox — the findings/coordination TRANSPORT; the barrier mints no new channel)
- **참조**:
  - `src/subagent/coordination/idle-barrier.ts` — PURE transforms (no I/O, no clock): `IdleBeacon {agentId, idleSince}`; `teamIdle(beacons, members) → boolean` (every member id beaconed; empty members ⇒ false); `idleSince(beacons, members) → number | undefined` (MAX member `idleSince` once whole-team-idle, else undefined; non-finite ⇒ undefined); `upsertBeacon` / `clearBeacon` (one entry per agent, pure). Plus `createIdleBarrier({now}) → IdleBarrierPort` — a thin in-memory port over an INJECTED clock (`beacon`/`reactivate`/`teamIdle`/`idleSince`).
  - `src/subagent/coordination/index.ts` — slice barrel (Capability C re-exports).
  - `src/side-agent/types.ts` — duck-typed `SideAgentIdleBarrierPort` (LOCAL mirror so the `src/side-agent/**` slice never hard-imports `@/subagent`) + the optional `SideAgentDaemonOpts.idleBarrier` injection + the `SideAgentDaemonRegistry.teamIdle()` / `idleSince()` fan-in reads.
  - `src/side-agent/registry.ts` — the supervise loop wiring: `beacon(id)` at spawn (BEFORE arming the trigger) + after each completed pass; `reactivate(id)` while a pass is in flight + on `finish` (terminal daemon leaves the team); `runningIds()` supplies the barrier's members; `teamIdle()` / `idleSince()` query it.
  - `src/agent/side-agent-runner.ts` — composition root: `wireSideAgentDaemons` injects `createIdleBarrier({ now: deps.now })` into the registry ONLY when `runtimeConfig().teamIdle`, reusing the real injected clock (no `Date.now()`).
  - `src/shared/runtime-config.ts` — `teamIdle` knob (`QUANTA_TEAM_IDLE === "1"`, strict opt-in, default false).
  - Tests: `tests/unit/coordination/team-idle-barrier-hellgate.test.ts` (pure-core predicate/transform pins), `tests/unit/coordination/team-idle-barrier-e2e-hellgate.test.ts` (`createIdleBarrier` over the in-memory port, 3-member beacon-by-beacon), `tests/unit/coordination/team-idle-side-agent-live-e2e-hellgate.test.ts` (REAL `createIdleBarrier` driving the REAL `@/side-agent` registry through the pass lifecycle).
  - Feature catalog: `tools/feature-catalog/features/09-integration/team-idle-barrier-coordination.yaml`.

## 맥락

Claude's `--agent-teams` model lets a leader coordinate a resident team of workers (the side-agent daemons of N1 — persistent background agents that wake on their own cadence and push findings, ADR-0130/0416). The leader periodically needs to advance: hand off to the next phase, fan results in, or shut the team down. The pre-existing way to know "is the team done?" is to POLL `registry.list()` and inspect each daemon's status/in-flight state on a cadence — wasteful, racy (a poll lands mid-pass), and it never tells you the INSTANT the team last quiesced.

Claude's team model instead has each member emit an **idle-notification beacon** at turn-end, and the leader awaits a **team-idle barrier** that releases only when the WHOLE team is quiescent. The barrier is a fan-IN: it releases when the last member goes idle, and its release timestamp is the moment that last member went idle. This ADR absorbs that — structurally, as a pure predicate over a beacon set, with no polling and no new heuristic.

The in-process `spawn_batch` fan-out (ADR-0436) already fans in via `Promise.all`, so it needs no barrier. The real value is the PERSISTENT team — the side-agent daemon registry, whose members are long-lived and wake independently — where there is no single `await` that resolves on whole-team quiescence. That is exactly where this barrier wires in.

## 결정

A two-layer slice in `@/subagent/coordination` (plane-clean pure leaf, imports nothing):

**PURE transforms** (no I/O, no clock, fully deterministic):

- `IdleBeacon { agentId, idleSince }` — one member's marker: its id + the epoch-ms instant it went idle (caller-/clock-supplied — never `Date.now()` inside the module).
- `teamIdle(beacons, members) → boolean` — the team is idle **iff EVERY member id carries a beacon**. Empty `members` ⇒ `false` (documented choice: no team ⇒ no barrier-release — never report a vacuous team as "done"). Stray beacons (ids not in `members`) are filtered out and never participate.
- `idleSince(beacons, members) → number | undefined` — the **barrier-release timestamp = the MAX `idleSince` across MEMBER beacons**, once the whole team is idle (= the moment the LAST member went idle). `undefined` when not all members are idle, or when `members` is empty. WHY MAX, not MIN: the barrier releases when the team FINISHES quiescing, which is gated by whichever member went idle LAST. A non-finite member `idleSince` (NaN / ±Infinity — a malformed beacon) makes the release instant UNKNOWABLE, so it returns `undefined` rather than silently dropping that member and releasing on a partial MAX.
- `upsertBeacon(beacons, beacon)` / `clearBeacon(beacons, agentId)` — record-or-replace (latest `idleSince` wins, exactly one entry per agent) / drop. Both PURE — return a new array, never mutate the input.

**The port** — `createIdleBarrier({ now })` returns an `IdleBarrierPort` over the pure transforms + an INJECTED clock (the ONLY time source, required so the barrier is deterministically testable with no `Date.now()`): member-side writes `beacon(agentId)` (marks idle as of `now()`) / `reactivate(agentId)` (clears — picked up work again), leader-side fan-in reads `teamIdle(members)` / `idleSince(members)`. One instance per team/session.

**The beacon protocol over the daemon lifecycle** (`src/side-agent/registry.ts`). The registry's RUNNING daemons are the barrier's members (`runningIds()`). The barrier is driven through the pass lifecycle:

- **spawn** ⇒ `beacon(id)` — a fresh daemon is idle. Beacon-then-arm ordering is load-bearing: an event trigger whose source fires SYNCHRONOUSLY during `subscribe` would otherwise run `wake` (which `reactivate`s = clears the beacon) BEFORE the beacon line, leaving a busy daemon falsely reported idle. Beaconing before arming makes a synchronous first wake's `reactivate` correctly clear the just-set beacon.
- **pass in flight** ⇒ `reactivate(id)` — set synchronously inside `wake` (before the awaited `runner.run`), so the daemon drops out of the idle set the instant it picks up work.
- **pass complete** ⇒ `beacon(id)` again as of `now()` — re-idle, advancing the release timestamp. Skipped once `applyPostPassBounds`/`finish` made the daemon terminal (a stopped daemon is not a member).
- **finish** (stop / fail / idle-reap) ⇒ `reactivate(id)` — a terminal daemon LEAVES the team; clearing its beacon bounds the barrier's beacon set over a long session (the query already filters by running members, so this is belt-and-suspenders).

The registry exposes `teamIdle()` (true iff every running daemon is quiescent) and `idleSince()` so a leader fans IN by reading whole-team quiescence in O(1) instead of polling `list()`.

**Slice fence**: `src/side-agent/**` never imports `@/subagent/coordination`. It defines a LOCAL duck-typed `SideAgentIdleBarrierPort` (structurally `IdleBarrierPort`); the composition root (`src/agent/side-agent-runner.ts`) is the sole place that couples the real barrier to the registry.

**Default-OFF / byte-identical**: `wireSideAgentDaemons` injects `createIdleBarrier({ now: deps.now })` into `opts.idleBarrier` ONLY when `runtimeConfig().teamIdle` (the `QUANTA_TEAM_IDLE === "1"` strict-opt-in knob). Absent ⇒ no barrier wired ⇒ `registry.teamIdle()` returns `false` and `idleSince()` returns `undefined` (the `?.` chain short-circuits), the daemon lifecycle runs no beacon/reactivate calls, and behavior is byte-identical to the pre-ADR legacy registry (the leader still polls). The barrier is purely additive: it can only EXPOSE a quiescence signal, never change the daemons' scheduling.

## 결과

- A leader can fan IN over the resident side-agent team by reading `teamIdle()` instead of polling `list()` on a cadence — the signal is exact (whole-team quiescence) and carries the release instant (`idleSince()` = when the team last fully idled).
- The pure core is fully deterministic and clock-free; the only time source is the injected clock, reused from the registry's own real clock at composition — no `Date.now()` anywhere in the slice.
- The slice fence holds: `@/side-agent` stays a pure leaf via a local duck-typed port; the coordination slice is imported only at the `@/agent` composition root.
- Zero blast radius when off: the `?.`-guarded injection means an unset knob produces byte-identical legacy behavior, so this can ship dark and be enabled per-deployment.

## Trade-offs / Negative invariants

Mined from the hellgate batteries:

- **The barrier NEVER releases early.** Partial beacons ⇒ `teamIdle === false` and `idleSince === undefined`; only a stray (unknown-member) beacon present ⇒ still `false`. `teamIdle` requires EVERY member id beaconed — a missing member can never be papered over.
- **Empty team ⇒ NOT idle** (documented choice). `teamIdle([], [])` and `teamIdle([beacon("ghost", …)], [])` both return `false`; a vacuous team is never reported "done". The live registry mirrors this: a registry with no running daemons ⇒ `teamIdle()` false.
- **Stray beacons never flip the barrier.** A beacon whose `agentId` is not in `members` is filtered before BOTH the predicate and the MAX, so an unknown member can neither complete the team nor contribute to the release timestamp (`idleSince` is the MAX over members only — the stray's timestamp is ignored even when it is the largest value).
- **Release timestamp is the MAX (last-idle), not MIN/first.** `idleSince` of `{a:10, b:30, c:20}` is `30`. A re-beacon (member went busy then idle again) REPLACES via `upsertBeacon` (one entry per agent, no duplicates) so the release ts advances to the latest, never stale.
- **Fail-safe on malformed beacons.** A non-finite member `idleSince` (NaN / +Infinity) keeps `teamIdle` true (the beacon is present) but forces `idleSince` to `undefined` — the barrier refuses to release on an unknowable instant rather than emitting NaN/Infinity or silently dropping the member.
- **Busy/idle transitions are exact through the pass lifecycle.** A pass in flight clears the beacon synchronously (`reactivate`) ⇒ `teamIdle()` flips false until the pass completes and re-beacons; with two daemons, the team is idle ONLY when BOTH are quiescent, and `idleSince()` is the MAX of the two. A stopped daemon leaves the team, so `teamIdle()` reflects the remaining members.
- **Purity is pinned.** `upsertBeacon` / `clearBeacon` return fresh arrays (a new copy even when nothing matched) and never mutate inputs — so a leader holding a snapshot of the beacon list is never surprised by an in-place edit.
- **Default-OFF is a tested invariant, not a convention.** The live-e2e hellgate spawns a daemon WITHOUT the barrier and asserts `teamIdle()` false / `idleSince()` undefined — proving the unset knob yields byte-identical legacy behavior, not an accidental always-idle.
