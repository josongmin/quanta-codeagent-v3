# ADR-0368 — Flock telemetry composition wire (deferred)

**Status:** Deferred (2026-05-28)
**Companion to:** ADR-0364 (flock operations telemetry — port + emit calls), ADR-0358 (codex-r2 metrics composition wire)
**Slice:** `agent/session-resource-registry` (analysis only — code mutation 0)
**Default-OFF:** N/A (no behavior change).

## Context

ADR-0364 added a `MetricEmitterPort` slot on `DiskRegistryConfig`:

```typescript
// src/agent/session-resource-registry/disk-adapter/types.ts
export interface DiskRegistryConfig {
  readonly storageDir: string
  // ...
  readonly metricsEmitter?: MetricEmitterPort  // ADR-0364
}
```

When set, the disk-store forwards the emitter through to
`acquireSessionLock(...)` so lockfile acquire / release / timeout /
stale-reclaim counters land on a `MetricsRegistry`. Absent ⇒ zero
emit calls, byte-identical to ADR-0356.

The slot is wired at the **disk-adapter constructor boundary**. It
takes effect only when the composition root that mints the disk
adapter PASSES the emitter through the config. The "happy path" we
might wire up:

```text
assemble.ts
  └─ adaptMetricsRegistryToEmitter(cfg.metrics) → metricsEmitter
  └─ getGlobalSessionResourceRegistry()         → process singleton (lazy-init)
       └─ buildDefaultRegistry()
            └─ createDiskSessionResourceRegistry({ storageDir, metricsEmitter? })
```

The structural goal of this ADR was to plug `metricsEmitter` into the
last line.

## Investigation — architectural mismatch

The wire CANNOT be done cleanly. Four design dead-ends:

### 1. Pass emitter through `assemble.ts`

`metricsEmitter` is derived **per assemble call** from `cfg.metrics`:

```typescript
// assemble.ts (existing — ADR-0358)
const metricsEmitter: MetricEmitterPort | undefined =
  cfg.metrics !== undefined && looksLikeMetricsRegistry(cfg.metrics)
    ? adaptMetricsRegistryToEmitter(cfg.metrics)
    : undefined
const sessionResources =
  cfg.sessionId !== undefined
    ? getGlobalSessionResourceRegistry().getOrCreate(cfg.sessionId)
    : null
```

The registry is the **lazy-init process singleton** (ADR-0347). Its
internal adapter was minted on a previous call (or this one) with NO
access to the per-call `cfg.metrics`. After that first mint, the
adapter is locked — `getOrCreate` only allocates per-session
`SessionResources`, it does NOT re-construct the adapter.

### 2. Mutate `global.ts` to read `cfg.metrics` somehow

`global.ts` is intentionally cfg-agnostic by ADR-0347 design:

> Default `createInMemorySessionResourceRegistry()` — no `maxEntries`,
> no `idleTtlMs`. Production callers responsible for size if it
> matters. A follow-up ADR can expose knobs (env vars, config slot)
> without changing the call-site shape here.

ADR-0351 added an env var. We could add a similar
`QUANTA_FLOCK_METRICS=on` env var — but the emitter is not an env-
typeable value. The emitter is a **port instance** that must be
threaded through from the same `MetricsRegistry` the rest of the
agent emits to. An env-toggle would have to construct a fresh
`MetricsRegistry` inside `global.ts`, which would NOT share metrics
with the agent's primary registry. That defeats the purpose.

### 3. Extend `getGlobalSessionResourceRegistry()` to take an emitter

Signature change:

```typescript
getGlobalSessionResourceRegistry(emitter?: MetricEmitterPort)
```

This breaks the lazy-init invariant: the emitter is "first-call
wins". A composition root assembled with `cfg.metrics = undefined`
that runs BEFORE the metricsful root locks the singleton without an
emitter. There is no clean way to ensure the metricsful caller is
first (the singleton mints itself on whichever `assemble.ts` runs
first per process).

Worse, ADR-0354 / ADR-0359 multi-tenant futures presume different
callers may want different observability surfaces. Threading one
emitter into the singleton bakes a single observability surface
into the process.

### 4. Factory parameter pattern (`metricsEmitterFactory`)

```typescript
interface DiskRegistryConfig {
  readonly metricsEmitterFactory?: () => MetricEmitterPort | undefined
}
```

The disk-store would call the factory on each `acquireSessionLock`,
deferring resolution. Composition roots register a process-wide
factory via a setter:

```typescript
registerGlobalMetricsEmitterFactory(() => currentRegistry.emitter)
```

This works mechanically but **trades a clean dependency-injection
shape for a mutable global**. The factory needs to be set BEFORE
the first lock acquire on each session, and clobbering it across
co-tenant composition roots produces silent observability drift.
Same first-call-wins fragility as option 3, just relocated.

## Decision

**Defer**. No code mutation in this ADR.

The flock telemetry hook (ADR-0364 `DiskRegistryConfig.metricsEmitter`)
remains supported for composition roots that **bring their own
registry** — i.e. those that bypass the global singleton:

```typescript
// Caller-owned registry path — emitter flows through naturally
const reg = createDiskSessionResourceRegistry({
  storageDir,
  metricsEmitter,
})
// thread `reg` through the host wire (NOT global singleton)
```

The global-singleton path (the default for `installCodexR2Wires`)
emits no flock telemetry. That is acceptable because:

1. ADR-0364 telemetry is **operational** (lock contention diagnostics
   on prod multi-process deployments). The MVP is single-process.
2. ADR-0358 cache telemetry already covers the **hot path** (cache
   hit / miss / invalidation) for the singleton-backed deployment.
3. ADR-0360 activation-hook telemetry covers per-turn plugin
   activation. The flock telemetry adds value only when contention
   is measurable; for single-process composition roots it is dead
   load.

## Re-open trigger

Re-open this ADR when ANY of the following becomes true:

- A multi-process deployment surfaces (e.g. CLI co-tenant + web
  daemon writing to the same `QUANTA_SESSION_REGISTRY_DISK_DIR`)
  with lock contention visible in operator reports.
- ADR-0354 (multi-tenant / per-surface registries) lands and changes
  the singleton contract from "one per process" to "one per
  surface", at which point option 3 (signature change) becomes
  tractable.
- A new ADR introduces a process-global observability bus that the
  registry can read at construction time without taking on
  per-assemble cfg dependency. (The MetricsRegistry-as-process-
  ambient pattern — currently NOT how `cfg.metrics` works.)

When any of the above happens, the recommended path is option 3
(signature change) restricted to the surface boundary, NOT option 4
(mutable global factory). Until then, the slot stays
caller-owned-only.

## Consequences

### Positive

- Zero code mutation. Zero risk of regression. Zero new test
  surface to maintain.
- ADR-0364 `metricsEmitter` slot stays available to caller-owned
  registries (host wire), so production deployments that need lock
  telemetry can opt in by skipping the global singleton.
- The architectural mismatch is documented, so the next agent that
  tries to wire this does not repeat the same investigation.

### Negative

- Operators using the global singleton (the common path) do not get
  flock telemetry "for free" — they would need to either switch to
  the SQLite backend (ADR-0367, no flock dependency) or build a
  caller-owned wire.
- The default deployment lacks lock-contention diagnostics. This is
  acceptable for MVP single-process operation but reduces forensic
  ability on contention bug reports until the re-open trigger fires.

## Slice fence

- **Mutates:** NOTHING. Documentation-only ADR.
- **Does NOT mutate:** any source file, any test, any catalog, any
  ADR cross-link.

## Related

- ADR-0345 — `SessionResourceRegistry` closed port
- ADR-0347 — Process-level singleton + lazy-init contract (the
  architectural constraint that drove the defer)
- ADR-0356 — Multi-process lockfile (the operation being telemetered)
- ADR-0358 — Codex-R2 metrics composition wire (the working
  precedent for cache-side emission; lock-side cannot follow this
  pattern for the reasons above)
- ADR-0364 — Flock operations telemetry (the `metricsEmitter` slot
  this ADR was supposed to wire)
- ADR-0367 — SQLite session-registry env-var swap (the SQLite
  backend is unaffected by this defer — it has no flock dependency)
