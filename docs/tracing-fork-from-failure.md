# Plane A — fork-from-failure (the one entrypoint)

- **Status:** documents an EXISTING capability (T-E2). No new engine — this note
  names + wires the scattered pieces into one path and points at the smoke.
- **Governance:** ADR-0539 (2-plane tracing SSOT). Plane A = the cassette
  (replay, req-hash, deliberately unredacted). This is a Plane A operation.
- **Smoke:** `tests/unit/fork-from-failure-smoke.test.ts` (end-to-end record →
  fork → resume). Per-primitive coverage:
  `tests/integration/replay-limit-and-truncate-hellgate.test.ts`.

## What it is

**Fork-from-failure** = replay a recorded (failed) bench trajectory up to turn
`N`, then RESUME LIVE from that point with a *different* config — so you can
cheaply re-test a localization / strategy / prompt fix on a recorded failure
**without** re-running the whole expensive run up to the failing turn.

This is the **bench-native** fork. It is distinct from the CLI `fork_session`
tool (`@/agent/fork-session`), which is REPL-scoped (`ConversationCheckpointStore`)
and **cannot** reach a bench trajectory cassette. For a bench run, the path
below is the only one that works.

## The entrypoint (all in `@/apps/bench/trajectory`)

The capability is three composable steps. There is intentionally no single
`forkFromFailure()` function — the steps are separate because you choose the
fork mechanism (in-place vs. file artifact) and the divergence policy per run.

### 1. RECORD the failing run

Recording is **default-ON** for bench (industry-SOTA opt-OUT). The tape lands at
`<benchHome>/runs/<runId>/trajectory.jsonl` (per-instance files under
`trajectories/<ts>-<instanceId>.jsonl`).

```
QUANTA_BENCH_RECORD_TRAJECTORY=1      # default; "0"/off to opt out
```

Under the hood: `maybeRecordTrajectory(llm)` → `recordingLlmPort({ inner, store })`.

### 2. FORK AT TURN N — pick ONE mechanism

- **In place, no copy** — cap how many recorded turns are eligible to replay:

  ```
  QUANTA_BENCH_REPLAY_TRAJECTORY=<tape.jsonl>
  QUANTA_BENCH_REPLAY_LIMIT=<N>        # non-negative int; invalid ⇒ throws loud
  ```

  `resolveBenchTrajectoryMode()` lands `limit:N` on the `replay` mode.

- **File artifact** — materialize a byte-faithful prefix cassette (source
  untouched; refuses `dest === src`):

  ```ts
  await truncateCassette(src, /* keep */ N, dest)
  // → { dest, kept, total }
  ```

### 3. REPLAY the prefix + RESUME LIVE past the fork

`replayTrajectoryPort({ path, onMiss, fallback, limit? })` builds the port:

- turns `1..N` replay from the cassette (deterministic);
- the first turn **past** the fork point misses the cassette and falls through
  to the live `fallback` — your resumed, reconfigured run.

Divergence policy (`QUANTA_BENCH_REPLAY_ON_MISS`, default `throw`):

- `throw` — strict; a short/stale cassette fails LOUDLY (no silent drift onto
  live output). Use when you expect a full replay.
- `passthrough` — diverge live at the fork point; do **not** extend the tape.
- `record-and-passthrough` — diverge live AND append the new turns to the tape
  (cassette expansion — the resumed run becomes replayable too).

```
QUANTA_BENCH_REPLAY_TRAJECTORY=<forked-or-full.jsonl>
QUANTA_BENCH_REPLAY_ON_MISS=record-and-passthrough
# optionally QUANTA_BENCH_REPLAY_LIMIT=<N> instead of a truncated file
```

Under the hood: `maybeReplayTrajectory(llm)` → `replayTrajectoryPort(...)`.

## End-to-end shape

```
record (step 1)            fork (step 2)              resume (step 3)
recordingLlmPort  ──►  truncateCassette(src,N,dest)  ──►  replayTrajectoryPort({
  (default-ON)     OR  QUANTA_BENCH_REPLAY_LIMIT=N          path, onMiss, fallback })
                                                        prefix replays; turn N+1 → live
```

The smoke `tests/unit/fork-from-failure-smoke.test.ts` drives exactly this
composition through the public primitives.
