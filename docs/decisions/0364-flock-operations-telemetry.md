# ADR-0364 — Flock operations telemetry

Status: Accepted
Date: 2026-05-27

## Context

ADR-0356 shipped the per-session lockfile (`<storageDir>/<sessionId>/.lock`)
that brings the disk-backed `SessionResourceRegistry` (ADR-0348) over
the multi-process safety bar. The lock's four outcome paths —
`success`, `timeout`, `fs error`, `stale reclaim` — are operationally
significant in ways the single-process baseline never had to surface:

- A spike in `timeout` rate means two quanta processes are colliding on
  the same `storageDir`; either the deploy is misconfigured (two CLI
  instances on the same machine + same `XDG_DATA_HOME`) or the user
  has two terminals targeting the same session id. Either way the
  operator wants to know.
- `stale reclaim` events should be rare in healthy deployments — the
  lock is held only for the synchronous duration of a `getOrCreate` +
  a microtask burst, so 30 s of staleness implies the holding process
  crashed (segfault, OOM, kill -9). A non-zero stale-reap rate is a
  reliability signal worth alerting on.
- `acquire latency` should be sub-millisecond in the uncontended path
  and bounded by the configured `timeoutMs` (default 5 s) on the
  contended one. Tail latency that grows linearly with session count
  hints at fs slowness (network mount, oversubscribed disk) or a
  pathologically long stale-check loop.
- `acquire fail` (any non-EEXIST fs error from the exclusive create:
  `EPERM`, `ENOSPC`, `EROFS`) means the disk-mirror has silently
  degraded to memory-only. Operators MUST see that.

ADR-0352 already ships the `MetricEmitterPort` (counter + gauge,
NO-THROW) and ADR-0358 wires `MetricsRegistry` (ADR-0144) to that port
at composition roots. The remaining gap: the lock module itself emits
nothing.

## Decision

Extend `AcquireSessionLockOpts` with an optional `metricsEmitter`
field. When provided, `acquireSessionLock` emits the following five
metrics, each NO-THROW and best-effort:

| Metric | Type | Emitted at |
|---|---|---|
| `codex_r2.lock.acquire_success` | counter +1 | every successful acquire (incl. same-process re-entry) |
| `codex_r2.lock.acquire_timeout` | counter +1 | every timeout-bail |
| `codex_r2.lock.acquire_fail` | counter +1 | every non-EEXIST fs error (mkdir / open) |
| `codex_r2.lock.stale_reclaim` | counter +1 | every stale-lockfile reap inside the retry loop |
| `codex_r2.lock.acquire_latency_ms` | gauge | wall-clock ms from start to success/timeout, via the `now` clock seam |

The metric vocabulary mirrors Codex's `codex.{conversation,turn,tool}.*`
OTel attribute family (memory `codex-otel-attribute-vocabulary`)
under the `codex_r2.lock.*` subspace — operators get the same
hit/miss/eviction/latency triad they already see on the cache +
registry decorators (ADR-0352).

The new options slot lives directly on `AcquireSessionLockOpts` so
every call site (currently only `disk-store.ts`) gets the wire for
free. `DiskRegistryConfig` also exposes a top-level
`metricsEmitter?` ergonomic alias — when `cfg.lock.metricsEmitter` is
absent but `cfg.metricsEmitter` is set, the disk-store merges the
top-level value into the resolved `AcquireSessionLockOpts` before
passing it to `acquireSessionLock`. The two-level surface keeps the
public-config shape backwards compatible (`cfg.metricsEmitter` is
optional + omitted ⇒ ZERO emit calls ⇒ byte-identical ADR-0356
behavior).

### Emit sites in `file-lock.ts`

- `acquireSessionLock` body — capture `wallStart = now()` BEFORE
  `ensureDir`. Latency includes mkdir + every retry sleep.
- `ensureDir` failure → emit `acquire_fail`, return null.
- Same-process re-entrancy fast path → emit `acquire_success` +
  `acquire_latency_ms` (latency ≈ 0). Re-entry is counted as success
  so operators see total acquire calls, not just the
  exclusive-create wins.
- `loopOnce` returns `acquired` → emit `acquire_success` +
  `acquire_latency_ms`, return lock.
- `loopOnce` returns `failed` → emit `acquire_fail`, return null.
- `loopOnce` returns `timeout` → emit `acquire_timeout` +
  `acquire_latency_ms`, return null.
- `loopOnce` stale-reap branch → emit `stale_reclaim` BEFORE the
  `unlinkSafe` so a reclaim followed by another contention doesn't
  lose the reap count.

### NO-THROW posture

Every emit goes through a private `safeEmit(emitter, fn)` helper that
wraps the call in try/catch + an undefined guard. A hostile emitter
that throws on every call is silently swallowed; the lock contract
remains intact. The `MetricEmitterPort` JSDoc (ADR-0352 §types.ts)
already promises NO-THROW, so this is defence-in-depth — there are
two layers between a buggy registry and the acquire path.

### Metric-name constants

`file-lock.ts` exports the five metric names as `as const`
identifiers (`LOCK_METRIC_*`) so the hellgate can assert exact
strings without retyping; downstream alert rules / dashboards
reference the same constant via a barrel export.

## Consequences

### Positive

- Operators get the four lock-outcome rates + latency as soon as the
  composition root wires a `MetricEmitterPort` (which it already
  does, per ADR-0358). No additional surface code required.
- The same emitter that already records cache hits / registry
  evictions now also records lock health — one unified `codex_r2.*`
  series for every R8/R9/R10 absorption knob.
- The `stale_reclaim` counter gives operators a direct view into
  process-crash rate via the lock-leftover signal — orthogonal to
  any external supervision (launchd / systemd) telemetry.

### Negative

- The `AcquireSessionLockOpts` surface grows by one optional field +
  the file-lock module now imports `MetricEmitterPort` from the
  codex-r2-metrics slice. The cross-slice coupling is ONE TYPE
  IMPORT (no value or runtime dependency) and stays plane-clean: the
  metrics slice does not depend on file-lock back.
- Same-process re-entry emits a success counter — operators that
  read the metric as "exclusive-create wins per second" will see
  inflated numbers if a single process holds the same lock from
  multiple registries. The trade-off favours observability: re-entry
  rate is itself an interesting signal (rare in production, common
  in test suites).

### Neutral

- Tests pass `metricsEmitter` explicitly when they want to observe
  emits; the existing 12 ADR-0356 hellgate cases are unchanged and
  continue to pass without an emitter (proving the byte-identical
  contract).

## Alternatives considered

### Reuse `MetricEmitterPort` from `@/observability/metrics` directly

Rejected — ADR-0352 deliberately keeps `MetricEmitterPort` agent-side
to avoid coupling the agent slice to the observability registry.
ADR-0358 closes the seam at composition time. Layering through that
seam preserves the test pyramid (lock unit tests don't stand up a
registry).

### Add `histogram` to `MetricEmitterPort` (latency as histogram, not gauge)

Rejected for now — ADR-0352 chose the 2-method shape (counter +
gauge) on purpose to keep the port a strict minimum. The activation
hook (ADR-0360) made the same decision and works around it by
emitting `sum_ms` as a counter. The same trick works here if
operators want histogram-shaped latency: emit `acquire_latency_ms`
as a gauge for the latest-value-wins case, AND a future ADR could
add an `acquire_latency_sum_ms` counter + `acquire_calls` counter
for mean latency. Out of scope here.

### Emit on `release()` too

Rejected — release is best-effort + idempotent + carries no
operationally-actionable signal (the holder always releases
eventually; releases that fail are already swallowed). The emit
overhead would dwarf the work being measured.

## Test plan

10 new hellgate cases in `__tests__/file-lock-telemetry.hellgate.test.ts`:

A. emitter absent → zero emits (byte-identical)
B. success path → `acquire_success` + latency
C. timeout path → `acquire_timeout` + latency
D. fs-error path → `acquire_fail`
E. stale reclaim → `stale_reclaim` then `acquire_success`
F. hostile emitter (throws) → swallow
G. latency uses `now` seam exactly
H. concurrent 5 acquires → 1 success + 4 timeouts
I. zero-timeout contention → `acquire_timeout`
J. same-process re-entry → second acquire emits success

Plus a metric-name-constants stability test.

All 11 tests pass. All 12 ADR-0356 hellgate cases pass unchanged.

## References

- ADR-0348 — Disk-persistent session-resource registry
- ADR-0352 — Codex-r2 observability metrics decorators
- ADR-0356 — Multi-process lockfile for the disk-backed session registry
- ADR-0358 — Composition wire for codex-r2 metrics
- ADR-0360 — Per-turn plugin activation telemetry (sibling design)
- ADR-0365 — Windows flock strategy (sibling)
- `codex-otel-attribute-vocabulary` memory — `codex.{turn,tool}.*` canonical naming
