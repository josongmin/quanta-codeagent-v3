/**
 * Default `AutoHookRegistrar` — ADR-0273.
 *
 * The registrar adapts `CacheLike` (ADR-0263 `EmbedCache`) and `StoreLike`
 * (ADR-0261 `VectorStore`) into the `InvalidationCallback` shape that the
 * ADR-0266 invalidator's registry consumes.
 *
 * Composition flow:
 *
 *   ```ts
 *   const registrar = createDefaultRegistrar()
 *   registrar.registerCacheHook(cache)
 *   registrar.registerStoreHook(store)
 *   const dispose = registrar.installAll(invalidator)
 *   // ...later, on swap:
 *   await invalidator.invalidateAll(listInvalidationCallbacks())
 *   // ...on teardown:
 *   dispose()
 *   ```
 *
 * Lifetime invariants the registrar holds:
 *   - **Default-OFF** — constructing the registrar without calling
 *     `installAll` mutates nothing; the invalidator's callback registry
 *     stays empty (HELL-AH-07).
 *   - **Callback isolation** — when `invalidator.invalidateAll(...)` runs
 *     the cache + store hooks back to back, one throwing does NOT prevent
 *     the other from running (HELL-AH-04). The default invalidator
 *     already enforces this; the registrar just preserves it by emitting
 *     plain `InvalidationCallback` entries with their own try/await
 *     boundaries.
 *   - **Cleanup tracking** — `installAll` returns an `UnregisterAll` that
 *     removes every callback the registrar attached, in registration
 *     order. Calling it twice is a no-op (HELL-AH-12).
 *   - **Re-install** — a second `installAll` is permitted (HELL-AH-06);
 *     each call returns its own independent disposal thunk.
 *   - **Null target** — `registerCacheHook(null)` / `registerStoreHook(null)`
 *     is a no-op + one warn (HELL-AH-08). Useful for optional-injection
 *     sites that pass `cache ?? null`.
 */

import {
  type InvalidationCallback,
  type Invalidator,
  registerInvalidationCallback,
} from "@/retrieval/versioning"
import type { AutoHookRegistrar, AutoHookRegistrarOptions, CacheLike, StoreLike } from "./port"
import type { UnregisterAll } from "./types"

/**
 * Default warn sink. Single source so test overrides via `onWarn` can
 * silence everything without bypassing the production OPS channel.
 */
const defaultOnWarn = (msg: string): void => {
  // biome-ignore lint/suspicious/noConsole: OPS warn is the documented surface
  console.warn(`[auto-hook] ${msg}`)
}

const defaultOnUnregisterError = (failure: { hook: string; error: unknown }): void => {
  const m =
    failure.error instanceof Error ? failure.error.message : String(failure.error ?? "<unknown>")
  // biome-ignore lint/suspicious/noConsole: OPS warn is the documented surface
  console.warn(`[auto-hook] unregister of ${failure.hook} failed: ${m}`)
}

/**
 * Validate the cache target's duck-typed surface. Returns `null` (with a
 * warn emitted) if the target is missing the `invalidate` method.
 */
const validateCache = (target: unknown, warn: (m: string) => void): CacheLike | null => {
  if (target === null || target === undefined) return null
  if (typeof (target as { invalidate?: unknown }).invalidate !== "function") {
    warn("cache target missing required method `invalidate`")
    return null
  }
  return target as CacheLike
}

const validateStore = (target: unknown, warn: (m: string) => void): StoreLike | null => {
  if (target === null || target === undefined) return null
  if (typeof (target as { delete?: unknown }).delete !== "function") {
    warn("store target missing required method `delete`")
    return null
  }
  return target as StoreLike
}

/**
 * Wrap a `CacheLike` into the `InvalidationCallback` shape. The reason
 * string is passed through to `cache.invalidate(reason)`; concrete
 * caches usually treat the reason as the model tag string to evict, but
 * the registrar does not interpret the value.
 */
const cacheCallback = (cache: CacheLike): InvalidationCallback => ({
  name: "auto-hook:cache",
  async invalidate(reason: string): Promise<void> {
    // Sync call wrapped to satisfy the async callback contract.
    cache.invalidate(reason)
  },
})

/**
 * Wrap a `StoreLike` into the `InvalidationCallback` shape. Calls
 * `store.delete([])` — concrete stores override delete-by-filter via
 * their own callback (this is the documented escape hatch).
 */
const storeCallback = (store: StoreLike): InvalidationCallback => ({
  name: "auto-hook:store",
  async invalidate(_reason: string): Promise<void> {
    await store.delete([])
  },
})

/**
 * Construct a fresh registrar. Each registrar instance is independent —
 * its staged cache + store targets do NOT leak across instances, and the
 * returned `UnregisterAll` only removes hooks this registrar attached.
 */
export const createDefaultRegistrar = (opts: AutoHookRegistrarOptions = {}): AutoHookRegistrar => {
  const onWarn = opts.onWarn ?? defaultOnWarn
  const onUnregisterError = opts.onUnregisterError ?? defaultOnUnregisterError

  let stagedCache: CacheLike | null = null
  let stagedStore: StoreLike | null = null
  // Reserved for future use — currently the invalidator port only exposes
  // a callback-list interface, so the registrar does not need per-instance
  // invalidator state beyond what `installAll` captures in its closure.
  void (null as Invalidator | null)

  return {
    registerCacheHook(cache: CacheLike | null): void {
      const validated = validateCache(cache, onWarn)
      if (validated === null && cache !== null && cache !== undefined) {
        // already warned by validator
        return
      }
      if (cache === null || cache === undefined) {
        onWarn("registerCacheHook called with null target — staging cleared")
        stagedCache = null
        return
      }
      if (stagedCache !== null && stagedCache !== validated) {
        onWarn("registerCacheHook replacing previously staged cache target")
      }
      stagedCache = validated
    },

    registerStoreHook(store: StoreLike | null): void {
      const validated = validateStore(store, onWarn)
      if (validated === null && store !== null && store !== undefined) {
        return
      }
      if (store === null || store === undefined) {
        onWarn("registerStoreHook called with null target — staging cleared")
        stagedStore = null
        return
      }
      if (stagedStore !== null && stagedStore !== validated) {
        onWarn("registerStoreHook replacing previously staged store target")
      }
      stagedStore = validated
    },

    installAll(_invalidator: Invalidator): UnregisterAll {
      const unregisters: Array<{ hook: string; fn: () => void }> = []
      let attached = 0

      if (stagedCache !== null) {
        const cb = cacheCallback(stagedCache)
        const off = registerInvalidationCallback(cb)
        unregisters.push({ hook: cb.name, fn: off })
        attached += 1
      }
      if (stagedStore !== null) {
        const cb = storeCallback(stagedStore)
        const off = registerInvalidationCallback(cb)
        unregisters.push({ hook: cb.name, fn: off })
        attached += 1
      }

      if (attached === 0) {
        onWarn("installAll called without any registered hook — no-op")
      }

      let disposed = false
      return (): void => {
        if (disposed) return
        disposed = true
        for (const { hook, fn } of unregisters) {
          try {
            fn()
          } catch (error) {
            onUnregisterError({ hook, error })
          }
        }
      }
    },
  }
}
