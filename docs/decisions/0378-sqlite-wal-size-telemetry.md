# ADR-0378 — SQLite WAL size telemetry

Status: Accepted
Date: 2026-05-28

## Context

ADR-0375 added an opt-in `walSizeThresholdBytes` knob so operators can
trigger a RESTART checkpoint when the WAL file balloons. But the
threshold is workload-dependent (Codex `logs_2.sqlite` reaches 14 GB
WAL after ~10 days of heavy use; quanta sessions can be smaller or
larger). With no observability on the actual WAL size, the threshold is
a guess.

The natural fix: surface the post-sweep WAL size to operators via the
existing ADR-0373 metric pipeline. Operators watch the gauge, pick a
threshold that fits their workload, and feed it back to
`walSizeThresholdBytes`.

## Decision

Two changes, both NO-THROW + opt-in:

1. **`SweepResult.walSize: number`** (sqlite-adapter/gc.ts) — added
   after the optional RESTART, read via the existing `readWalSize`
   helper. Always present in the returned shape; `0` when the WAL file
   is missing (DB never written, or PASSIVE drained it).

2. **`codex_r2.sqlite.wal_bytes` gauge** (auto-sweep.ts) — emitted via
   `safeGauge` after every sqlite sweep when `metricsEmitter` is
   present. Absent emitter ⇒ no emit ⇒ byte-identical to ADR-0373 path.

## Why post-sweep (not pre-sweep)

The whole point is to inform ADR-0375 threshold tuning. The threshold
governs upgrade behaviour AFTER the PASSIVE checkpoint (and possibly
after RESTART). The post-checkpoint size is the steady-state value
operators care about — the value the next sweep's threshold check will
see.

## Why a gauge (not a counter)

WAL size is a current-value observation, not a monotonic accumulation.
Gauges are the canonical OTel + ADR-0144 shape for that.

## Non-goals

- **Pre-sweep WAL size.** Not surfaced — would conflate "WAL before
  this sweep" with "WAL after this sweep" without resolving which
  threshold consumers actually want. Single value, post-sweep, end of
  story.
- **Per-step WAL size.** Could surface PASSIVE vs RESTART deltas; not
  needed today (the threshold knob is per-sweep, not per-step).
- **Histogram.** Gauge is sufficient for the threshold-tuning use case;
  a histogram would let operators graph WAL-size distributions but no
  one has asked for that yet.

## Files

- `src/agent/session-resource-registry/sqlite-adapter/gc.ts` —
  `SweepResult.walSize` field + 1-line `readWalSize` call after the
  checkpoint block.
- `src/agent/session-resource-registry/auto-sweep.ts` — 1-line
  `safeGauge` emit after the sqlite sweep.

## Hellgate

- `src/agent/session-resource-registry/sqlite-adapter/__tests__/gc.hellgate.test.ts`
  — [EE-HH] 4 new cases (always non-negative / WAL missing ⇒ 0 / EMPTY
  path ⇒ 0 / read after checkpoint).
- `tests/unit/auto-sweep-hellgate.test.ts` — [Y-AA] 3 new cases (sqlite
  path emits gauge / no emitter ⇒ no gauge / disk-only path ⇒ no gauge).

`bun test sqlite-adapter/__tests__/gc.hellgate.test.ts` ⇒ 18/0 fail
(14 retained + 4 new). `bun test auto-sweep-hellgate.test.ts` ⇒ 27/0 fail
(24 retained + 3 new).

## References

- ADR-0144 — `MetricsRegistry.gauge` shape
- ADR-0352 — codex-r2 observability decorators
- ADR-0361 — sqlite session-registry backend (Codex parity)
- ADR-0373 — auto-sweep telemetry (this ADR extends)
- ADR-0375 — WAL size threshold + RESTART (this ADR provides the
  observability that ADR-0375 needs)
