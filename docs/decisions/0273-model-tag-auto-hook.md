# ADR-0273: ModelTag invalidator auto-hook — EmbedCache + VectorStore registrar seam

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related**: ADR-0266 (the ModelTag versioning + invalidator primitive
  this slice attaches to), ADR-0263 (the `EmbedCache` whose
  `invalidate(modelTag)` method the cache hook calls),
  ADR-0261 (the `VectorStore` whose `delete(ids)` method the store
  hook calls).
- **References**:
  `src/retrieval/auto-hook/types.ts` (`UnregisterAll`, closed 3-arm
  `AutoHookError`),
  `src/retrieval/auto-hook/port.ts` (`AutoHookRegistrar` closed port +
  duck-typed `CacheLike` / `StoreLike` shapes),
  `src/retrieval/auto-hook/default-registrar.ts` (default registrar —
  staging, validation, install, dispose),
  `src/retrieval/auto-hook/index.ts` (barrel),
  `tests/unit/retrieval/auto-hook-hellgate.test.ts` (12 cases).

## Context

ADR-0266 ships the ModelTag invalidator primitive: a pure `check` rule
plus an `invalidateAll(callbacks)` fan-out that walks every registered
`InvalidationCallback`. The wiring of a concrete `EmbedCache`
(ADR-0263) and `VectorStore` (ADR-0261) into that callback list is the
**consumer's** job — ADR-0266 deliberately stops at the registry seam.

In practice every composition root that constructs a cache + store
**also** wants those layers to flush when the embedder is swapped.
Hand-rolling an `InvalidationCallback` shim around `cache.invalidate(tag)`
and `store.delete(ids)` at every composition root is duplicate boilerplate
and a source of asymmetric bugs (cache hooked, store forgotten).

This ADR ships the seam: a single `AutoHookRegistrar` that takes a
cache + a store (or either one, or neither) and attaches them to the
ADR-0266 invalidator's callback registry. The registrar **does not**
import `@/retrieval/cache` or `@/retrieval/engines/store` directly — it
duck-types on the method signatures so the slice stays a leaf and any
composition root can use it without dragging the cache + engine surface
into the build graph.

## Decision

### Slice layout

```
src/retrieval/auto-hook/
  types.ts                 — UnregisterAll, AutoHookError (closed 3-arm)
  port.ts                  — AutoHookRegistrar { registerCacheHook(cache)
                                                 registerStoreHook(store)
                                                 installAll(invalidator): UnregisterAll }
                             CacheLike { invalidate(modelTag: string): number }
                             StoreLike { delete(ids: readonly string[]): Promise<unknown> }
                             AutoHookRegistrarOptions { onWarn, onUnregisterError }
  default-registrar.ts     — createDefaultRegistrar — staging, validation,
                             install via registerInvalidationCallback,
                             dispose tracking
  index.ts                 — barrel
```

### Composition flow

```ts
import { createDefaultRegistrar } from "@/retrieval/auto-hook"
import {
  createDefaultInvalidator,
  listInvalidationCallbacks,
} from "@/retrieval/versioning"

const invalidator = createDefaultInvalidator()
const registrar = createDefaultRegistrar()

registrar.registerCacheHook(cache)
registrar.registerStoreHook(store)
const dispose = registrar.installAll(invalidator)

// ... later, when the embedder is swapped:
await invalidator.invalidateAll(listInvalidationCallbacks())

// ... on teardown:
dispose()
```

### Duck-typed cache + store

`CacheLike` matches the `EmbedCache.invalidate(modelTag): number`
signature (ADR-0263). `StoreLike` matches the
`VectorStore.delete(ids: readonly string[]): Promise<unknown>` signature
(ADR-0261). The registrar imports nothing from those slices — the
matching is purely structural. This keeps `@/retrieval/auto-hook` a leaf
slice installable from any composition root.

The store hook calls `store.delete([])` — an explicit no-op-by-default
because the registrar cannot enumerate stored ids without leaking the
store's internal layout. Concrete stores that want bulk-purge semantics
register their own `InvalidationCallback` via
`registerInvalidationCallback(...)` directly (the documented escape
hatch). This is consistent with ADR-0266's "consumer owns the wiring"
posture.

### Default-OFF byte-identical

If `createDefaultRegistrar()` is constructed but `installAll(...)` is
never called, **nothing is attached** to the invalidator's callback
registry. The ADR-0266 invariant "no registered callback ⇒
`invalidateAll` is a no-op observer" is preserved verbatim. The slice
files are pure code — importing the barrel does nothing observable.

### Callback isolation

ADR-0266 already guarantees one callback throwing does not stop the
others (HELL-MT-12). The registrar preserves that property by emitting
plain `InvalidationCallback` entries that each await their own work in
isolation. The hellgate explicitly proves this with HELL-AH-04 (cache
hook throwing → store hook still fires).

### Closed `AutoHookError` (3 arms)

```ts
type AutoHookError =
  | { kind: "null-target"; which: "cache" | "store" }
  | { kind: "missing-method"; which: "cache" | "store"; method: string }
  | { kind: "install-without-target" }
```

`null-target` covers `registerCacheHook(null)` /
`registerStoreHook(null)` — tolerated for optional-injection sites that
pass `cache ?? null`; one warn, no throw, staging cleared.
`missing-method` covers structural mismatches (object lacks
`invalidate` / `delete`); validator rejects, one warn, no throw.
`install-without-target` covers `installAll(invalidator)` with no
staged hooks; the returned `UnregisterAll` is still a valid no-op, but
the registrar emits one warn so a mis-composed root surfaces fast.

The union is closed; `default: never` exhaustive-switch coverage is
enforced by HELL-AH-11.

### Cleanup tracking

`installAll(...)` returns an `UnregisterAll` thunk. Calling it removes
**only** the callbacks this registrar attached on that specific
`installAll` call, in registration order. Subsequent
`invalidateAll(...)` runs see an empty (or reduced) callback list. A
second call to the same `UnregisterAll` is an idempotent no-op
(HELL-AH-12).

### Re-install

A second `installAll(invalidator)` on the same registrar after the first
dispose is permitted and produces a fresh, independent disposal thunk
(HELL-AH-06). Each `installAll` captures its own unregister list in
closure — there is no shared mutable state on the registrar's hot path.

### `exactOptionalPropertyTypes` discipline

The slice is built with `exactOptionalPropertyTypes` **explicitly
omitted** on `AutoHookRegistrarOptions.onWarn` and
`AutoHookRegistrarOptions.onUnregisterError`. The literal
`{}` and `{ onWarn: fn }` are both valid call-sites — callers do not
need to spell `onWarn: undefined` for the default warn to apply. This
matches the ergonomic posture of ADR-0266
(`DefaultInvalidatorOptions.onCallbackError`).

## Consequences

**Positive**

- Composition roots get a one-call seam:
  `registrar.registerCacheHook(cache); registrar.registerStoreHook(store);
  registrar.installAll(invalidator)` — no duplicate `InvalidationCallback`
  boilerplate.
- Asymmetric bugs (cache hooked, store forgotten) become a single-site
  audit instead of an N-site grep.
- Leaf slice — no import back-edges into `@/retrieval/cache` or
  `@/retrieval/engines/store`; cache / store evolve independently.
- Default-OFF byte-identical — composition root that does not call
  `installAll` runs identically to the pre-ADR baseline.

**Negative / accepted**

- `store.delete([])` is a no-op-by-default on most stores; concrete
  bulk-purge wiring is the store's responsibility via a hand-rolled
  `InvalidationCallback` (escape hatch is documented).
- `exactOptionalPropertyTypes` is intentionally omitted on registrar
  options for ergonomic literal `{}` call-sites.
- The registrar uses the ADR-0266 process-global callback registry; if
  a project ever needs multiple isolated invalidator instances, the
  registrar will need a per-invalidator registry (not in scope).

## Hellgate

`tests/unit/retrieval/auto-hook-hellgate.test.ts` — 12 cases:

- HELL-AH-01: `registerCacheHook → installAll → invalidateAll` triggers
  `cache.invalidate`.
- HELL-AH-02: `registerStoreHook → installAll → invalidateAll` triggers
  `store.delete([])`.
- HELL-AH-03: cache + store both registered → both fire on
  `invalidateAll`.
- HELL-AH-04: cache hook throwing does NOT prevent store hook from
  running (callback isolation).
- HELL-AH-05: `UnregisterAll` → subsequent `invalidateAll` does not fire
  the registrar's hooks.
- HELL-AH-06: `installAll` called twice → second produces a fresh,
  independent disposal thunk.
- HELL-AH-07: registrar constructed but `installAll` never called →
  invalidator registry stays empty (byte-identical to pre-ADR).
- HELL-AH-08: `registerCacheHook(null)` → no-op + warn; registry stays
  empty.
- HELL-AH-09: concurrent `invalidateAll` invocations are safe (no shared
  mutable state).
- HELL-AH-10: 1000 sequential registrar lifecycles complete in bounded
  time (< 2 s sanity bound).
- HELL-AH-11: `AutoHookError` 3-arm exhaustive switch compiles and
  labels every arm.
- HELL-AH-12: `UnregisterAll` is idempotent — second call is a no-op,
  hooks remain cleaned up.
