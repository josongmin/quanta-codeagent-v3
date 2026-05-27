# ADR-0383 — Unified `getOrCreateRegistry(opts)` API (additive, non-breaking)

**Status:** Accepted (2026-05-28)
**Companion to:** ADR-0347 (global singleton),
ADR-0372 (caller-owned registry path)
**Slice:** `agent/session-resource-registry` (1 new leaf file +
1-line barrel export + 1 hellgate file)
**Default-OFF:** Yes — opts absent ⇒ byte-identical to
`getGlobalSessionResourceRegistry()`.

## Context

Two registry-mint paths coexist in the codebase today:

1. **ADR-0347** `getGlobalSessionResourceRegistry()` — process singleton,
   lazy-init, env-driven backend (`QUANTA_SESSION_REGISTRY_SQLITE_PATH`
   wins over `QUANTA_SESSION_REGISTRY_DISK_DIR`, in-memory default).
   Auto-sweep handle (ADR-0369) attaches on the same first call.
2. **ADR-0372** `buildCallerOwnedRegistryWithTelemetry({ emitter })` —
   per-call fresh mint that bypasses the singleton so a composition
   root holding a `MetricsRegistry` can thread flock telemetry through
   the disk-adapter. ADR-0368 documented why the singleton path CANNOT
   be retroactively wired (lazy-init mismatch).

Composition roots that need both shapes import both helpers. Two import
sites for a single concept ("mint a session-resource registry") is a
small but real maintenance tax. This ADR ships a single entry point that
picks the right path from a single flag — additive only.

## Decision

Introduce `src/agent/session-resource-registry/unified-api.ts`:

```typescript
export interface UnifiedRegistryOptions {
  readonly callerOwned?: boolean
  readonly metricsEmitter?: MetricEmitterPort
  readonly sessionId?: string
}

export const getOrCreateRegistry = (
  opts?: UnifiedRegistryOptions,
): SessionResourceRegistry
```

### Behavior table (5 cases — pinned by hellgate §A–§F)

| `opts`                                       | `metricsEmitter` | `callerOwned` | Result                                             |
|----------------------------------------------|------------------|---------------|----------------------------------------------------|
| `undefined` or `{}`                          | —                | —             | global singleton (ADR-0347), byte-identical        |
| `{ callerOwned: false }`                     | —                | `false`       | global singleton                                   |
| `{ callerOwned: true, metricsEmitter: X }`   | present          | `true`        | caller-owned (ADR-0372) — fresh, emitter wired     |
| `{ callerOwned: true }`                      | absent           | `true`        | NO-THROW fallback → global singleton               |
| `{ metricsEmitter: X }`                      | present          | —             | global singleton (emitter ignored)                 |

### Two deliberate semantic calls

1. **Emitter alone does NOT trigger caller-owned.** The opt-in must be
   explicit (`callerOwned: true`). This matches today's behavior — the
   global singleton ignores `metricsEmitter` (that's the whole reason
   ADR-0372 exists). Forwarding an emitter without the flag is a no-op
   instead of a silent ownership swap.
2. **`callerOwned: true` without emitter falls back to global.** ADR-0372
   exists to thread telemetry; without an emitter there's no advantage
   over the singleton. We could have minted a caller-owned-without-emit
   instance instead, but that would split the call-site contract into
   four states. Three is enough — global vs caller-owned-with-telemetry,
   with a graceful safety hatch.

### NO-THROW posture

The delegation to `buildCallerOwnedRegistryWithTelemetry` is wrapped in
try/catch. ADR-0372's builder is itself NO-THROW, so the catch is
belt-and-braces (future regression guard). On any failure the global
singleton is returned — callers always receive a usable
`SessionResourceRegistry`.

## Consequences

### Positive

- **One entry point** for new composition roots. Existing call sites
  unchanged — both `getGlobalSessionResourceRegistry()` and
  `buildCallerOwnedRegistryWithTelemetry()` keep their signatures.
- **Byte-identical opts-absent path.** `getOrCreateRegistry()` is
  reference-equal to `getGlobalSessionResourceRegistry()` (hellgate §M).
- **Future migration path.** A follow-up ADR may deprecate one of the
  two original entry points once all callers migrate. This ADR does
  NOT mandate deprecation — that's a separate decision once we
  observe adoption.

### Negative

- **Three names for two paths.** Until a follow-up consolidates, the
  codebase exposes three mint entry points. The barrel re-exports all
  three so the call site can pick its preferred shape; in practice
  new code uses `getOrCreateRegistry`, legacy code keeps working.
- **`metricsEmitter` without `callerOwned: true` is a no-op.** A
  caller passing only `metricsEmitter` will get a registry that does
  NOT emit. We considered routing on emitter-alone (auto-promote to
  caller-owned) but rejected: implicit ownership flips are a
  documented anti-pattern (see ADR-0368 §3 "factory pattern" rejection).

## Non-goals

- **Deprecating ADR-0347 or ADR-0372.** Both keep their exports.
- **Mutating `assemble.ts`/`loop.ts`/`prompt.ts`.** Composition roots
  continue using the existing entry points; migration is a separate ADR.
- **Per-surface multi-tenant registries** (ADR-0354 — still out of scope).
- **Global-singleton telemetry wire** (ADR-0368 deferred — caller-owned
  path remains the supported answer).

## Wiring status

- **NEW** `src/agent/session-resource-registry/unified-api.ts` — leaf,
  imports only siblings + `MetricEmitterPort` type.
- **+1 line** in `src/agent/session-resource-registry/index.ts` barrel.
- **NO** mutation of `global.ts`, `caller-owned-builder.ts`,
  `assemble.ts`, `loop.ts`, `prompt.ts`.

## Tests

`tests/unit/unified-registry-api-hellgate.test.ts` pins all 13 cases
(§A through §M). 13 pass / 0 fail / 23 expects.

Behavior matrix is the entire surface — there is no additional state
machine to test. Existing ADR-0347 + ADR-0372 hellgates (R10–R13)
continue to pass because this file does not mutate either path.

## Follow-up roadmap

- **No immediate deprecation.** ADR-0347 + ADR-0372 entry points stay.
- **If adoption proves out:** a future ADR may add a soft-deprecation
  notice (jsdoc + biome rule) on one of the original entry points and
  migrate the remaining call sites in a single sweep. Naming the
  candidate now would be premature — measure first.
