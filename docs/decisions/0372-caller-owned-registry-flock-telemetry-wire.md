# ADR-0372 — Caller-owned registry path for flock telemetry production wire

**Status:** Accepted (2026-05-28)
**Closes:** ADR-0368 (flock telemetry composition wire — deferred)
**Companion to:** ADR-0364 (flock operations telemetry), ADR-0358
(codex-r2 metrics composition wire), ADR-0347 (global singleton)
**Slice:** `agent/session-resource-registry` (new factory file) +
`apps/agent/assemble.ts` (1 import + 1 if-branch)
**Default-OFF:** Yes — wire activates only when `cfg.metrics` is a real
`MetricsRegistry` (ADR-0144 shape). Absent ⇒ byte-identical legacy.

## Context

ADR-0364 added `metricsEmitter` to `DiskRegistryConfig`. ADR-0368
investigated four ways to wire it through the composition root and
**deferred** because all four paths broke either the
`getGlobalSessionResourceRegistry()` lazy-init invariant or the
"single observability surface per process" multi-tenant future
(ADR-0354):

1. Pass emitter through `assemble.ts` ⇒ singleton already minted on a
   previous call without it; cannot retroactively wire.
2. Read `cfg.metrics` inside `global.ts` ⇒ emitter is a port instance,
   not env-typeable; would have to construct a fresh registry, defeating
   the purpose.
3. Signature change `getGlobalSessionResourceRegistry(emitter?)` ⇒
   first-call-wins; metricsful caller is not guaranteed to run first.
4. Factory pattern `metricsEmitterFactory` ⇒ trades clean DI for a
   mutable global; same fragility as (3).

ADR-0368 §re-open-trigger pointed to the **caller-owned path** as the
viable alternative: composition roots that already own a
`MetricsRegistry` mint a FRESH registry instance (bypassing the
singleton) so the emitter flows through naturally.

This ADR ships exactly that path.

## Decision

Introduce a new factory and a minimal `assemble.ts` mutation:

### 1. `src/agent/session-resource-registry/caller-owned-builder.ts` (NEW)

```typescript
export const buildCallerOwnedRegistryWithTelemetry = (
  opts: CallerOwnedBuilderOpts,
): SessionResourceRegistry => {
  // Same env priority as global.ts::buildDefaultRegistry:
  // 1. QUANTA_SESSION_REGISTRY_SQLITE_PATH ⇒ sqlite (NO emit — WAL)
  // 2. QUANTA_SESSION_REGISTRY_DISK_DIR    ⇒ disk-adapter w/ emitter
  // 3. otherwise                           ⇒ in-memory (NO emit)
}
```

Plus a convenience wrapper:

```typescript
export const buildCallerOwnedSessionResources = (
  sessionId: string,
  registry: SessionResourceRegistry,
): SessionResources => registry.getOrCreate(sessionId)
```

Every call returns a NEW registry instance — no caller-side singleton.
NO-THROW (every backend constructor wrapped in try/catch + falls
through; in-memory cannot fail).

### 2. `src/apps/agent/assemble.ts` (1 import + 1 if-branch)

```typescript
import { buildCallerOwnedRegistryWithTelemetry } from
  "@/agent/session-resource-registry/caller-owned-builder"
```

The `sessionResources` lookup splits on `metricsEmitter`:

```typescript
const sessionResources =
  cfg.sessionId !== undefined
    ? metricsEmitter !== undefined
      ? buildCallerOwnedRegistryWithTelemetry({
          emitter: metricsEmitter,
          sessionId: cfg.sessionId,
        }).getOrCreate(cfg.sessionId)
      : getGlobalSessionResourceRegistry().getOrCreate(cfg.sessionId)
    : null
```

`metricsEmitter !== undefined` is true iff `cfg.metrics` passed
`looksLikeMetricsRegistry` (ADR-0358). Absent ⇒ legacy global-singleton
path is preserved verbatim.

## Non-goals

- **Global singleton mutation.** `global.ts` is unchanged. None of the
  ADR-0368 four options is taken — the slot stays caller-owned-only.
- **SQLite emitter wiring.** WAL handles concurrency; no flock to
  telemeter on the SQLite backend.
- **In-memory emitter wiring.** No lock either; no emit calls.
- **Cross-process sharing.** Each caller-owned registry is a fresh
  instance; same-sessionId reuse across DIFFERENT `assemble.ts` calls
  is NOT preserved (the global singleton was the reuse mechanism, and
  it is bypassed by design). Hosts that need reuse AND metrics keep a
  single `MetricsRegistry` instance + accept that each `assemble.ts`
  call mints a fresh session-resource registry. The disk-backed
  durability layer still rehydrates from disk, so prior typed-history
  events + cache entries are replayed on next assemble — the reuse
  loss is purely the per-process in-memory `Map`, not the persisted
  state.

## TDD log

16 hellgate cases — all RED first, GREEN after implementation.

### Builder hellgate — 12 cases
(`tests/unit/caller-owned-registry-builder-hellgate.test.ts`)

| § | Pin | RED | GREEN |
|---|-----|-----|-------|
| A | emitter present, disk env unset ⇒ in-memory (no emit) | Module not found | Builder returns in-memory, log empty |
| B | emitter present, disk env set ⇒ disk-adapter minted | Module not found | events.jsonl appears on disk |
| C | disk path emitter receives `codex_r2.lock.acquire_success` | Module not found | Counter observed via emitter |
| D | sqlite env ⇒ sqlite adapter, NO emit | Module not found | log entries do NOT match `codex_r2.lock.*` |
| E | caller-owned ≠ global singleton | Module not found | Different references |
| F | Multiple builder calls ⇒ separate instances | Module not found | r1 !== r2 |
| G | NO-THROW on disk path unreadable | Module not found | Builder returns a working registry |
| H | emitter throws ⇒ swallowed at disk-adapter | Module not found | append does not throw |
| I | sessionId optional | Module not found | Builder accepts both shapes |
| J | env priority sqlite > disk | Module not found | sqlite chosen; no `codex_r2.lock.*` emit |
| K | `buildCallerOwnedSessionResources` delegates | Module not found | Same reference as `registry.getOrCreate(id)` |
| L | Instance not module-retained (reset-singleton independence) | Module not found | r1 still usable post-reset |

### Assemble wire hellgate — 4 cases
(`tests/unit/assemble-caller-owned-wire-hellgate.test.ts`)

| § | Pin | RED | GREEN |
|---|-----|-----|-------|
| M | `cfg.metrics` absent ⇒ legacy singleton path | Initially passed (existing legacy path) | Re-verified after wire |
| N | `cfg.metrics` MetricsRegistry ⇒ caller-owned, global stays empty | Singleton `peek` non-null (used singleton) | Singleton `peek` null (caller-owned took over) |
| O | `cfg.metrics` + no sessionId ⇒ caller-owned skipped | Initially passed | Re-verified after wire |
| P | End-to-end `codex_r2.lock.acquire_success` lands on `cfg.metrics` | `saw === false` (telemetry dropped on the floor) | `saw === true` (emitter received the counter) |

REFACTOR — biome auto-fix + tsc cleanup; no semantic changes.

## Consequences

### Positive

- ADR-0368 architectural mismatch resolved without mutating
  `global.ts` or its lazy-init contract.
- Composition roots that wire `cfg.metrics` get flock telemetry "for
  free" — single line of caller wire (already there via ADR-0358).
- Default-OFF: hosts that do NOT use `cfg.metrics` see byte-identical
  behavior (16 hellgate cases pin this — §M / §O paths assert legacy
  semantics).
- Slice-clean: 1 new file + 1 import + 1 if-branch in `assemble.ts`.
- No new ports, no port surface widening; reuses ADR-0364's
  `metricsEmitter` slot exactly as designed.

### Negative

- **Reuse loss across same-process assembles** — when `cfg.metrics`
  is set, every `assemble.ts` call mints a fresh registry. Same-
  sessionId reuse across calls only works through the disk-adapter's
  rehydrate-on-`getOrCreate` path (ADR-0348). In-memory-only state
  (e.g. an LRU cache populated mid-session) is lost between assembles.
  Mitigation: composition roots that need both metrics AND in-process
  reuse can manually mount a single registry once and inject it
  through `cfg.systemPromptCache` / `cfg.store` directly (ADR-0332
  caller-override-precedence preserves those).
- **No SQLite flock telemetry.** Correct by design (WAL replaces
  flock) — but operators that switch to SQLite see no
  `codex_r2.lock.*` series at all. This is documented; not a bug.

## Slice fence

- **Adds:**
  - `src/agent/session-resource-registry/caller-owned-builder.ts` (NEW, ~120 LOC including header)
  - `tests/unit/caller-owned-registry-builder-hellgate.test.ts` (12 cases)
  - `tests/unit/assemble-caller-owned-wire-hellgate.test.ts` (4 cases)
  - `docs/decisions/0372-caller-owned-registry-flock-telemetry-wire.md` (this file)
- **Mutates:** `src/apps/agent/assemble.ts` (1 import line + 1 if-branch
  in the `sessionResources` lookup; semantics unchanged when
  `metricsEmitter === undefined`).
- **Does NOT mutate:** `global.ts`, `disk-store.ts`, `file-lock.ts`,
  `loop.ts`, `prompt.ts`, `installCodexR2Wires`, any session-registry
  test, any catalog entry. ADR-0368's "defer" stance stands — the
  global singleton path remains untelemetered by design.

## Related

- ADR-0345 — `SessionResourceRegistry` closed port
- ADR-0347 — Process-level singleton (the architectural constraint)
- ADR-0348 — Disk-persistent jsonl adapter
- ADR-0356 — Multi-process lockfile
- ADR-0358 — Codex-R2 metrics composition wire (cache path)
- ADR-0360 — Activation hook telemetry
- ADR-0361 — SQLite session-registry backend (no flock — WAL parity)
- ADR-0364 — Flock operations telemetry (the slot wired here)
- ADR-0366 — Codex-R2 metrics slice relocation + histogram retry
- **ADR-0368 — Flock telemetry composition wire (deferred)** ← this
  ADR closes
- ADR-0371 — Worktree-staleness preamble (procedural guardrail
  applied during this ADR's authoring)
