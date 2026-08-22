/**
 * `@/retrieval/auto-hook` closed port — ADR-0273.
 *
 * The registrar wraps the ADR-0266 invalidator's callback registry so
 * composition roots can attach `EmbedCache` (ADR-0263) and `VectorStore`
 * (ADR-0261) instances *as data* — instead of every consumer hand-rolling
 * an `InvalidationCallback` shim around `cache.invalidate(tag)` and
 * `store.delete(ids)`.
 *
 * The cache and store types are duck-typed (`CacheLike` / `StoreLike`)
 * so this slice does NOT import `@/retrieval/cache` or
 * `@/retrieval/engines/store` directly. That keeps `@/retrieval/auto-hook`
 * a leaf slice — installable from any composition root without dragging
 * the entire cache + engine surface into the build graph.
 *
 * Default-OFF: importing this module does nothing observable. The
 * registrar's `installAll(invalidator)` is the only entry point that
 * mutates the invalidator's registry; without it, behaviour is
 * byte-identical to the pre-ADR baseline (HELL-AH-07).
 */

import type { Invalidator } from "@/retrieval/versioning"
import type { UnregisterAll } from "./types"

/**
 * Duck-typed shape the registrar accepts as a cache target.
 *
 * Matches `EmbedCache.invalidate(modelTag: string): number` (ADR-0263).
 * The registrar only calls `invalidate(reason)` — the return value is
 * ignored (the cache reports its own metric).
 *
 * Sync because the underlying `EmbedCache` port is sync. The hook itself
 * is `async` (Promise-returning) because the invalidator's
 * `InvalidationCallback.invalidate` is async — the registrar adapts the
 * sync cache call up into the async callback shape.
 */
export interface CacheLike {
  invalidate(modelTag: string): number
}

/**
 * Duck-typed shape the registrar accepts as a store target.
 *
 * Matches `VectorStore.delete(ids: readonly string[])` (ADR-0261). The
 * registrar's store hook calls `delete([])` with an empty id list — the
 * actual "delete every doc of this tag" wiring is the store's
 * responsibility (the registrar does NOT enumerate ids; that would
 * defeat duck typing).
 *
 * If the store-side `delete([])` is a no-op, the registrar surfaces a
 * single warn on the OPS channel during `installAll` so the misconfigured
 * compose root is visible. Concrete stores that want bulk-purge semantics
 * implement it via their own callback wrapper around the invalidator
 * registry (this is the documented escape hatch).
 */
export interface StoreLike {
  delete(ids: readonly string[]): Promise<unknown>
}

/**
 * Options for `createDefaultRegistrar`.
 */
export interface AutoHookRegistrarOptions {
  /**
   * Called once per warn-worthy condition during `registerCacheHook`,
   * `registerStoreHook`, or `installAll`. Default routes to
   * `console.warn` with a `[auto-hook]` prefix.
   *
   * Override to silence the warn or feed a structured logger.
   */
  readonly onWarn?: (msg: string) => void

  /**
   * Called when an `unregister` thunk produced by the underlying
   * `registerInvalidationCallback` throws while `UnregisterAll` is
   * iterating. Default routes to `console.warn`. Errors are isolated —
   * one failing unregister never blocks the rest (HELL-AH-12).
   */
  readonly onUnregisterError?: (failure: { hook: string; error: unknown }) => void
}

/**
 * Closed port for the auto-hook registrar.
 *
 * Lifecycle:
 *   1. `registerCacheHook(cache)` — stage a cache target (zero or one
 *      cache supported; the second call replaces the first, the
 *      registrar warns when a replacement happens so silent overwrites
 *      surface).
 *   2. `registerStoreHook(store)` — same shape for the store target.
 *   3. `installAll(invalidator)` — attach the staged targets to the
 *      invalidator's callback registry and return a single
 *      `UnregisterAll` thunk.
 *   4. Caller invokes the returned `UnregisterAll` during teardown. A
 *      second `installAll` MAY be called after teardown — each
 *      `installAll` returns its own independent `UnregisterAll`
 *      (HELL-AH-06).
 *
 * The registrar is process-local — concurrent `installAll` calls on the
 * same registrar produce independent disposal handles. The underlying
 * invalidator registry already serialises mutations.
 */
export interface AutoHookRegistrar {
  registerCacheHook(cache: CacheLike | null): void
  registerStoreHook(store: StoreLike | null): void
  installAll(invalidator: Invalidator): UnregisterAll
}
