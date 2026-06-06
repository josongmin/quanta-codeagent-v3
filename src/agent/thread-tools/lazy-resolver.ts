/**
 * Lazy resolver (ADR-0206).
 *
 * The resolver owns the FACTORY-RESULT CACHE — it is INTENTIONALLY
 * separate from the spec store so the spec object itself stays
 * referentially stable (and `Object.freeze`-able). For `deferLoading=true`
 * specs, the first `resolveOnce(threadId, name, factory)` call runs
 * the factory and caches the `Tool`; subsequent calls return the same
 * `Tool`.
 *
 * Single-flight: the factory is synchronous (`() => Tool`), so a
 * single Map `has`-check guard suffices — there is no async window
 * during which a second call could slip in before the first sets the
 * cache.
 *
 * For `deferLoading=false`, the store invokes `cacheEager(threadId,
 * name, tool)` once at register-time so subsequent resolves bypass
 * the factory entirely.
 *
 * Plane-clean: imports only `@/shared` + `@/tool` + sibling types.
 */

import { err, errMessage, ok, type Result } from "@/shared"
import type { Tool } from "@/tool"
import type { ResError } from "./types"

/** Composite key used to identify a cache entry. */
type CacheKey = `${string}\x00${string}`

const keyFor = (threadId: string, name: string): CacheKey => `${threadId}\x00${name}` as CacheKey

export interface LazyResolver {
  /** Pre-populate the cache (used by `deferLoading=false` registration). */
  cacheEager(threadId: string, name: string, tool: Tool): void
  /** Resolve a deferred spec: returns cached `Tool` if present, else runs
   *  `factory` exactly once and caches the result. Factory throw →
   *  `Err("factory-failed")` (the cache is NOT poisoned; a future call
   *  re-runs `factory`). */
  resolveOnce(threadId: string, name: string, factory: () => Tool): Result<Tool, ResError>
  /** Peek without running. Used by tests / diagnostics. */
  peek(threadId: string, name: string): Tool | null
  /** Drop every cache entry whose key starts with `threadId\x00`. */
  evictThread(threadId: string): void
  /** Drop a single cache entry. Used by `evictNamespace`. */
  evictOne(threadId: string, name: string): void
}

export const defaultLazyResolver = (): LazyResolver => {
  const cache = new Map<CacheKey, Tool>()
  return {
    cacheEager(threadId, name, tool) {
      cache.set(keyFor(threadId, name), tool)
    },
    resolveOnce(threadId, name, factory) {
      const k = keyFor(threadId, name)
      const hit = cache.get(k)
      if (hit !== undefined) return ok(hit)
      let built: Tool
      try {
        built = factory()
      } catch (cause) {
        const msg = errMessage(cause)
        return err({
          code: "factory-failed",
          cause,
          message: `factory for '${name}' (thread '${threadId}') threw: ${msg}`,
        })
      }
      cache.set(k, built)
      return ok(built)
    },
    peek(threadId, name) {
      const hit = cache.get(keyFor(threadId, name))
      return hit === undefined ? null : hit
    },
    evictThread(threadId) {
      const prefix = `${threadId}\x00`
      for (const k of cache.keys()) {
        if (k.startsWith(prefix)) cache.delete(k)
      }
    },
    evictOne(threadId, name) {
      cache.delete(keyFor(threadId, name))
    },
  }
}
