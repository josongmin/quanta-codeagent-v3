/**
 * ADR-0326 — System prompt cache strict drift detector (wrapper adapter).
 *
 * # What this is
 *
 * A wrapping adapter that, on every `getOrBuild` HIT, runs the factory
 * AGAIN and compares the freshly-built text's SHA-256 against the
 * cached `contentHash`. If they differ ⇒ `DriftDetectedError` is thrown
 * with both digests embedded.
 *
 * This turns ADR-0322's PASSIVE audit (which only fires when a recorder
 * is wired) into an ACTIVE invariant: any caller wrapping their cache
 * with this detector pays the extra build cost in exchange for
 * fail-fast detection of "someone folded per-turn data into the cached
 * prompt without realising".
 *
 * # Default-OFF in production
 *
 * The detector is NOT used by any production wiring. It exists for
 * audit / regression-suite / replay-time strict checks. Production
 * callers use the bare in-memory cache where a hit is O(1) and never
 * re-runs the factory.
 *
 * # Behaviour on miss
 *
 * The detector is a pure pass-through on miss — the inner cache runs the
 * factory once, stores the result, and returns. The detector does NOT
 * "double build" on miss; that would be wasteful and impossible to
 * distinguish from a producer with a non-deterministic factory (which
 * would always throw, defeating the purpose).
 *
 * # Slice fence
 *
 * Imports `./hash.ts` + `./types.ts` + `./port.ts`. No cross-slice
 * imports.
 */

import { sha256Hex } from "./hash"
import type { SystemPromptCachePort } from "./port"
import {
  type CachedPrompt,
  type CacheStats,
  DriftDetectedError,
  type InvalidationReason,
  type SystemPromptCacheKey,
} from "./types"

/**
 * Wrap a `SystemPromptCachePort` so that every HIT re-runs the factory
 * and asserts the cached text is byte-stable.
 *
 * Returns a new port that delegates to `inner` for all storage; only
 * `getOrBuild` is overridden. Counters, invalidation, peek, and clearAll
 * pass through verbatim — they're observability surfaces that should
 * never be affected by the strict check.
 *
 * Throws {@link DriftDetectedError} on a hit-and-rebuild mismatch.
 *
 * @example
 * ```ts
 * const cache = makeStrictDriftCache(createInMemorySystemPromptCache())
 * cache.getOrBuild(key, () => "v1")  // miss — stored
 * cache.getOrBuild(key, () => "v1")  // hit + rebuild ⇒ same hash ⇒ ok
 * cache.getOrBuild(key, () => "v2")  // hit + rebuild ⇒ different hash ⇒ throws
 * ```
 */
export const makeStrictDriftCache = (inner: SystemPromptCachePort): SystemPromptCachePort => {
  const getOrBuild = (key: SystemPromptCacheKey, factory: () => string): CachedPrompt => {
    const existed = inner.peek(key)
    if (existed === null) {
      // Miss path — delegate. The factory will run exactly once inside
      // `inner.getOrBuild`. NO double-build.
      return inner.getOrBuild(key, factory)
    }
    // Hit path — re-run the factory and compare. This is the WHOLE point
    // of the strict detector; the extra cost is on purpose.
    const fresh = factory()
    const freshHash = sha256Hex(fresh)
    if (freshHash !== existed.contentHash) {
      throw new DriftDetectedError(key, existed.contentHash, freshHash)
    }
    // Hash matched — return the cached entry so `builtAt` keeps its
    // original "first built at" semantics. We still let the inner cache
    // record the hit via a no-op delegate call (so `stats().hits` keeps
    // counting); the inner's factory is a passthrough that returns the
    // same text the first call produced.
    return inner.getOrBuild(key, () => existed.text)
  }

  return {
    getOrBuild,
    peek: (key) => inner.peek(key),
    invalidate: (key, reason) => inner.invalidate(key, reason),
    clearAll: (reason: InvalidationReason) => inner.clearAll(reason),
    stats: (): CacheStats => inner.stats(),
  }
}
