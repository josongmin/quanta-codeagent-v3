# ADR-0369 — Auto-wire `sweepDiskRegistry` + `sweepSqliteRegistry` (on-startup + periodic)

**Status:** Accepted (2026-05-28)
**Sibling to:** ADR-0345 (in-memory registry), ADR-0347 (process singleton wire), ADR-0348 (disk JSONL adapter + sweep), ADR-0351 (disk env-var swap), ADR-0361 (SQLite adapter + sweep)
**Slice:** `agent`
**Default-OFF:** YES — env-gated; absent env vars ⇒ byte-identical to ADR-0347.

## Context

ADR-0348 shipped `sweepDiskRegistry(cfg)` and ADR-0361 shipped
`sweepSqliteRegistry(cfg)`. Both encode the retention algorithm
(TTL + sliding-window) verbatim. **Nothing in the process calls them on
a schedule.** Concretely:

- `disk-store.ts` runs a per-`getOrCreate` lazy sweep — adequate while
  there is `getOrCreate` traffic, but an idle process (long-running
  daemon between turns) never reclaims.
- `sqlite-store.ts` has **no** lazy hook — every sweep must be triggered
  externally.

Net effect: any caller that opts into a persistent backend
(`QUANTA_SESSION_REGISTRY_DISK_DIR=…` ADR-0351 path, or a manual mount
of the SQLite adapter via ADR-0361) accumulates on-disk state without
bound. The disk adapter eventually self-limits via the per-getOrCreate
lazy sweep; the SQLite adapter does not.

Codex solves the same problem with a **separate daemon process** that
runs `logs_2.sqlite` GC every 5–15 minutes (memory
`codex-logs-retention-pattern`). Quanta is a single process, so we run
the sweep **in-process** on a timer.

## Decision

Introduce a leaf module `src/agent/session-resource-registry/auto-sweep.ts`
that owns the periodic sweep loop, and wire it from
`getGlobalSessionResourceRegistry()` first-call (the same lazy-init
seam ADR-0347 owns).

### Public surface

```typescript
export interface AutoSweepConfig {
  readonly intervalMs?: number              // default 60_000
  readonly diskDir?: string                 // cfg overrides env
  readonly sqlitePath?: string              // cfg overrides env
  readonly now?: () => number               // clock seam
  readonly setIntervalImpl?: …              // test seam
  readonly clearIntervalImpl?: …            // test seam
}

export interface AutoSweepHandle {
  readonly stop: () => void                 // idempotent, NO-THROW
  readonly sweepNow: () => Promise<void>    // forced sweep, NO-THROW
  readonly scheduled: boolean
}

export const DEFAULT_AUTO_SWEEP_INTERVAL_MS = 60_000

export function startAutoSweep(cfg?: AutoSweepConfig): AutoSweepHandle
```

### Trigger policy

Two env vars gate the loop independently:

| Env var                                 | Effect                              |
| --------------------------------------- | ----------------------------------- |
| `QUANTA_SESSION_REGISTRY_DISK_DIR`      | schedule `sweepDiskRegistry`        |
| `QUANTA_SESSION_REGISTRY_SQLITE_PATH`   | schedule `sweepSqliteRegistry`      |

- **Both set** ⇒ both backends swept on every tick. The two sweeps are
  orthogonal (different on-disk artefacts); they do not preclude one
  another.
- **Neither set** ⇒ `startAutoSweep` returns a shared no-op handle.
  `scheduled === false`, no `setInterval` registered, no allocations.
- **Empty string** ⇒ treated as unset (same convention as ADR-0351).

`QUANTA_SESSION_REGISTRY_SQLITE_PATH` is **new** and used **only by
this ADR**. It does NOT swap the global registry to the SQLite backend
— that is out of scope (a follow-up ADR may add the swap on the
ADR-0351 pattern). A composition root that manually mounts the SQLite
backend via the factory opts into retention by also setting this env
var.

### Timing

- **On-startup sweep (1×)** runs IMMEDIATELY on `startAutoSweep` so a
  long-idle process catches accumulated debt on next boot. Fire-and-
  forget; callers can `await handle.sweepNow()` to synchronise.
- **Periodic sweep** runs every `intervalMs` (default 60 000 ms).
- `intervalMs <= 0` ⇒ no periodic timer; the on-startup sweep still
  runs and `sweepNow()` is still callable.

### Default-cadence justification (60 s)

- Short enough that a write burst is reclaimed within a turn or two.
- Long enough that the CPU/IO budget per tick is < 1% on a steady
  workload (sweep walks ~100s of session dirs / SQLite rows).
- Codex's external `logs_2.sqlite` daemon runs every 5–15 minutes; we
  run tighter because we are in-process and want sub-minute
  convergence after a burst.

### NO-THROW contract

- Every `sweepDiskRegistry` / `sweepSqliteRegistry` call is wrapped.
  Disk full, corrupt DB, permission errors degrade to "no rows
  evicted"; the timer keeps ticking.
- `startAutoSweep` itself NO-THROWS on construction (a hosed env var
  leaves the timer ticking with empty sweeps).
- `stop()` is idempotent + NO-THROW (safe to call multiple times,
  safe to call on a never-started handle).

### `resetGlobalSessionResourceRegistry` semantics

The companion reset in `global.ts` MUST stop the in-flight handle
before clearing the singleton instance — otherwise tests leak `setInterval`
handles across files and the next `getGlobalSessionResourceRegistry()`
call leaves the old timer running against a dead registry. This ADR
extends `global.ts` to:

```ts
let autoSweepHandle: AutoSweepHandle | null = null

export const getGlobalSessionResourceRegistry = () => {
  if (instance === null) {
    instance = buildDefaultRegistry()
    if (autoSweepHandle === null) {
      try { autoSweepHandle = startAutoSweep() } catch { /* NO-THROW */ }
    }
  }
  return instance
}

export const resetGlobalSessionResourceRegistry = () => {
  if (autoSweepHandle !== null) {
    autoSweepHandle.stop()
    autoSweepHandle = null
  }
  instance = null
}
```

## Non-goals

- **Cross-process coordinator.** Two processes both with the env vars
  set will both sweep the same files. The sweeps are FK-cascade /
  line-aware idempotent; double sweeps cost CPU but cannot corrupt.
  A future ADR may add a multi-process flock around the sweep itself
  (we already have ADR-0356 lockfile for the per-session writes).
- **`/registry-sweep` slash command.** A manual force-sweep CLI knob
  is a separate ADR (the `sweepNow()` method on the handle is the
  in-process equivalent — the slash command is just a CLI surface
  on top).
- **Sqlite backend auto-mount.** This ADR adds the sweep env var but
  does NOT swap the global registry to the SQLite backend. Composition
  roots that want the SQLite backend still call the factory directly.
- **Telemetry.** Sweep counts (`SweepResult`) are returned by the
  underlying sweep functions but this ADR does not forward them to
  the metrics emitter. A follow-up ADR may wire them through
  `MetricEmitterPort` once we have a baseline of how chatty the
  emit would be.

## Consequences

- Persistent-backend callers no longer accumulate on-disk state
  without bound.
- In-memory default callers pay zero cost (no `setInterval`, no
  allocations beyond the shared `NOOP_HANDLE` constant).
- Test isolation is preserved via the `resetGlobalSessionResourceRegistry`
  wire — handle is stopped before instance is cleared.
- The handle exposes `sweepNow()` so a shutdown hook can force a
  final flush (e.g. `process.on('exit', () => autoSweepHandle?.sweepNow())`)
  without re-implementing the env-gated sweep policy.

## Test plan

`tests/unit/auto-sweep-hellgate.test.ts` — 16 cases:
- env unset, disk env set, sqlite env set, both set
- default intervalMs = 60 000, override forwards, `intervalMs <= 0`
  ⇒ no timer
- empty-string env ⇒ unset
- cfg override wins over env
- NO-THROW under repeated ticks
- double-stop / never-started stop
- `sweepNow()` resolves under both env-set + env-unset
- `stop()` flips the timer's `cleared` flag
- `getGlobalSessionResourceRegistry` byte-identical without env
- `resetGlobalSessionResourceRegistry` idempotent under env set

## File layout

```
src/agent/session-resource-registry/
  auto-sweep.ts            (new, ADR-0369)
  global.ts                (mutated: +startAutoSweep wire, +stop in reset)
  index.ts                 (mutated: +export AutoSweepConfig/Handle/start)
docs/decisions/
  0369-session-registry-auto-sweep.md
tests/unit/
  auto-sweep-hellgate.test.ts (new)
```

Slice-fence honoured: no `prompt.ts`, no `loop.ts`, no `assemble.ts`
mutations.
