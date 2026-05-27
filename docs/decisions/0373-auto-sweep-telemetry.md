# ADR-0373 — Auto-sweep telemetry (codex-r2 metric emit for disk + sqlite retention)

**Status:** Accepted (2026-05-28)
**Sibling to:** ADR-0352 (codex-r2 metrics types), ADR-0366 (codex-r2 metrics relocation + histogram), ADR-0369 (session-registry auto-sweep)
**Slice:** `agent/session-resource-registry/auto-sweep.ts` + `tests/unit/auto-sweep-hellgate.test.ts`
**Default-OFF:** YES — absent `metricsEmitter` ⇒ byte-identical to ADR-0369.

## Context

ADR-0369 introduced the env-gated `startAutoSweep` periodic loop that
drives ADR-0348 (`sweepDiskRegistry`) + ADR-0361 (`sweepSqliteRegistry`)
in-process. The sweep result is currently **discarded** — there is no
way to observe how many sessions are reclaimed per tick, how long the
sweep takes, or whether the SQLite PASSIVE checkpoint succeeded.

ADR-0352 / ADR-0366 already define the canonical `MetricEmitterPort`
shape (counter / gauge / optional histogram) the rest of the absorption
cycle emits through. ADR-0373 closes the loop: thread an OPTIONAL
emitter into `AutoSweepConfig` and emit the sweep outcomes.

## Decision

Extend `AutoSweepConfig` with an optional `metricsEmitter: MetricEmitterPort`
field. When supplied, `sweepOnce` emits the following metric names
after each backend completes:

| Metric                              | Type      | Source                                  |
| ----------------------------------- | --------- | --------------------------------------- |
| `codex_r2.sweep.disk_evicted`       | counter   | `sweepDiskRegistry().evicted`           |
| `codex_r2.sweep.disk_truncated`     | counter   | `sweepDiskRegistry().truncated`         |
| `codex_r2.sweep.sqlite_evicted`     | counter   | `evictedByTtl + evictedBySize`          |
| `codex_r2.sweep.sqlite_checkpointed`| counter   | `1` on success, `0` on miss             |
| `codex_r2.sweep.latency_ms`         | histogram → gauge fallback | `Date.now() - wallStart` |

### NO-THROW contract

Every emitter call is wrapped in `try/catch` via `safeCounter` /
`safeGauge` / `safeLatency` helpers. A misbehaving emitter (throwing
implementation, OOM, etc.) is swallowed so the sweep loop's existing
NO-THROW contract is preserved.

### Histogram fallback

`MetricEmitterPort.histogram` is OPTIONAL (ADR-0366 widened the port
post-hoc). When the emitter does NOT define `histogram`, the latency
value falls back to `gauge("codex_r2.sweep.latency_ms", value)`. This
keeps timing observability available even on older emitter literals
(test stubs, legacy adapters).

### Counter-on-zero (case W)

`sweepDiskRegistry` and `sweepSqliteRegistry` may legitimately return
`{ evicted: 0, … }` on a freshly-deployed process. The emit still
fires with `delta = 0` so the dashboard's "sweep ran" signal is
preserved. Idempotent counter emits with delta = 0 are a no-op on the
backend.

### Default-OFF

When `metricsEmitter` is absent, the sweep loop is byte-identical to
ADR-0369: no extra `Date.now()` call, no emitter overhead, no helper
invocations. The byte-identical guarantee is locked by case Q.

## Wiring

ADR-0373 does NOT yet auto-wire `metricsEmitter` from a composition
root — opt-in via direct `startAutoSweep({ ..., metricsEmitter })`
call. A follow-up ADR will adapt the global singleton path to plumb
the ADR-0358 metrics registry when active (the ADR-0347
`getGlobalSessionResourceRegistry` path).

## Test coverage (8 new cases Q-X)

| Case | Pin                                                              |
| ---- | ---------------------------------------------------------------- |
| Q    | absent emitter ⇒ byte-identical                                  |
| R    | disk evicted counters emit                                       |
| S    | sqlite checkpointed counter emits                                |
| T    | histogram emitted when present, gauge fallback otherwise         |
| U    | throwing emitter ⇒ swallowed, timer survives                     |
| V    | both backends ⇒ both sets of metrics emit on one sweep           |
| W    | zero-result sweep still emits delta-0 (idempotent observability) |
| X    | `sweepNow()` + on-startup sweep both fire emit                   |

All 16 pre-existing cases (A-P) continue to pass — byte-identical.

## Non-goals

- Auto-wiring the global singleton metrics emitter (separate ADR).
- New histogram bucket configuration (ADR-0366 owns histogram shape).
- Sweep failure attribution (current NO-THROW swallows errors before
  we know which axis failed) — a follow-up ADR may add per-axis
  `*.error` counters.
