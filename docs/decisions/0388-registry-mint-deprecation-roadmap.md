# ADR-0388 — Registry-mint deprecation roadmap (ADR-0383 follow-up)

**Status:** Accepted (2026-05-28)
**Type:** Roadmap (no code change)
**Companion to:** ADR-0347 (global singleton),
ADR-0372 (caller-owned-with-telemetry),
ADR-0383 (unified `getOrCreateRegistry`)
**Default-OFF:** N/A — markdown only.

## Context

After ADR-0383 the codebase exposes **three** registry-mint entry points:

1. `getGlobalSessionResourceRegistry()` (ADR-0347) — process singleton,
   env-driven backend selection.
2. `buildCallerOwnedRegistryWithTelemetry({ emitter, sessionId })`
   (ADR-0372) — fresh per-call mint that bypasses the singleton so a
   `MetricsRegistry` can be threaded through the disk adapter for
   ADR-0364 flock telemetry.
3. `getOrCreateRegistry(opts)` (ADR-0383) — unified additive entry
   point that routes between the two above based on
   `opts.callerOwned` + `opts.metricsEmitter`.

ADR-0383 §"Follow-up roadmap" deferred the deprecation question:

> No immediate deprecation. ADR-0347 + ADR-0372 entry points stay.
> If adoption proves out: a future ADR may add a soft-deprecation
> notice on one of the original entry points and migrate the
> remaining call sites in a single sweep. Naming the candidate now
> would be premature — measure first.

This ADR is that follow-up — it names criteria, not a date. We measure
adoption first, then act.

## Current production call-site inventory (2026-05-28)

Grepped via `getGlobalSessionResourceRegistry\|buildCallerOwnedRegistryWithTelemetry\|getOrCreateRegistry`.

| Call site                                          | Helper used                                  | Migrateable? |
|----------------------------------------------------|----------------------------------------------|--------------|
| `src/apps/agent/assemble.ts:208–212`               | Ternary — both ADR-0347 + ADR-0372           | **Yes** — direct fit for `getOrCreateRegistry({ callerOwned, metricsEmitter, sessionId })` |
| `src/apps/cli/session-registry-cmd.ts:132`         | `getGlobalSessionResourceRegistry().evict()` | **No** — evict targets the singleton intentionally |
| `src/agent/session-resource-registry/inspector.ts` | `getGlobalSessionResourceRegistry()`         | **No** — inspector reads the singleton by contract |
| `src/agent/session-resource-registry/auto-sweep.ts`| `getGlobalSessionResourceRegistry()`         | **No** — sweep operates on the singleton by contract |

Non-production (tests + builders) keep using the underlying helpers
directly — they need the concrete shapes for hellgate cases.

**Net real-world migration candidate: 1 call site** (`assemble.ts`).

## Decision

**Migration gating criteria.** Promote `getOrCreateRegistry` to the
canonical entry point in production code when **all three** are true:

1. **At least 3 distinct production composition roots** want to mint
   a registry. Today we have 1 (`assemble.ts`). At 3 the abstraction
   tax stops looking premature.
2. **Caller-owned-with-telemetry adoption is non-zero.** As of
   2026-05-28 only `assemble.ts` mints caller-owned (and only when
   `cfg.metrics` is a real `MetricsRegistry`). If no second consumer
   appears within 30 days, that's a signal ADR-0372 is over-built
   and we revisit ADR-0368's "global singleton + lazy telemetry"
   rejection instead of consolidating around it.
3. **No new deprecation-incompatible behavior lands** on either
   underlying helper. If ADR-0347 grows a singleton-only feature
   (e.g. multi-tenant routing per ADR-0354 if revived) the unified
   API would need a corresponding extension before deprecation.

If all three hold, the migration sweep is:

- Soft-deprecate (jsdoc `@deprecated` + biome `noRestrictedImports`
  rule in `slice-fence`) on **`buildCallerOwnedRegistryWithTelemetry`**
  (the more specialized one) — not on `getGlobalSessionResourceRegistry`.
- Migrate `assemble.ts:208–212` ternary to a single
  `getOrCreateRegistry({ callerOwned: metricsEmitter !== undefined,
  metricsEmitter, sessionId: cfg.sessionId }).getOrCreate(cfg.sessionId)`
  call.
- Keep `getGlobalSessionResourceRegistry` un-deprecated — it's used by
  `inspector.ts` + `auto-sweep.ts` + the `/session-registry evict`
  slash, and those callers are NOT minting (they're reading the
  already-minted singleton). Deprecating it would force noise on
  consumers that have nothing to migrate.

## Why deprecate ADR-0372, not ADR-0347

ADR-0372 is the **specialized** one — it exists solely so a caller
holding a `MetricsRegistry` can thread flock telemetry. The unified
API exposes the same capability via opts, so once `assemble.ts`
migrates the only production consumer of `buildCallerOwnedRegistryWithTelemetry`
disappears.

ADR-0347 is the **load-bearing** one — three production consumers
(inspector, auto-sweep, evict slash) read the singleton and have no
reason to mint via the unified API (they're not picking between
ownership shapes — they need *the* singleton). Deprecating it would
force noise on consumers with nothing to migrate.

## Non-goals

- **Deprecating `getGlobalSessionResourceRegistry`.** See above — it
  is the singleton accessor, and the unified API is built on top of
  it. The singleton remains the foundation.
- **Removing either helper after deprecation.** Soft-deprecation only;
  removal would be a separate ADR with a 30-day notice + grep of
  external consumers.
- **Forcing a specific migration date.** Criteria-gated; we measure
  adoption and act when the criteria fire.

## Acceptance criteria for the sweep ADR (future ADR-0XXX)

When the criteria fire, the sweep ADR must include:

1. **Updated call-site inventory** — re-run the grep above and confirm
   the migration target list.
2. **Biome rule** — `noRestrictedImports` entry that bans
   `buildCallerOwnedRegistryWithTelemetry` outside of the slice
   itself + its hellgate file.
3. **JSDoc `@deprecated` tag** — points at `getOrCreateRegistry` as
   the replacement, with a one-line migration recipe.
4. **Hellgate** — a "no-production-caller" test that fails if any
   `src/**` outside the slice imports the deprecated helper.

## References

- ADR-0347 — Global session-resource-registry singleton
- ADR-0364 — Disk-adapter flock counters
- ADR-0368 — Why singleton + lazy telemetry was rejected
- ADR-0372 — Caller-owned-with-telemetry builder
- ADR-0383 — Unified `getOrCreateRegistry(opts)` API
