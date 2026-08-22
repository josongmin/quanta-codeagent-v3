/**
 * ADR-0326 — System prompt cache (in-memory adapter).
 *
 * Default `SystemPromptCachePort` implementation. Backed by a single
 * `Map<SystemPromptCacheKey, CachedPrompt>`. No persistence, no LRU eviction —
 * the cache lives for the duration of one process and is sized by the
 * caller's session-key cardinality (one entry per session, typically O(1) in
 * production, O(N) in test suites).
 *
 * # Clock seam
 *
 * `now` is injected (defaults to `Date.now`) so tests get deterministic
 * `builtAt` values. Same pattern as `src/agent/admissibility-gate.ts` and
 * `src/memory/consolidate/writer.ts`.
 *
 * # Concurrency
 *
 * Single-threaded; see port docblock. The Map is never iterated during
 * `getOrBuild`, so there is no reentrancy hazard between hit/miss and
 * invalidation calls in normal usage.
 *
 * # Failure semantics
 *
 * `factory` may throw. When it does, the cache state is UNCHANGED (no
 * partial write, no half-tracked counter), and the throw propagates to the
 * caller verbatim. This matches the Codex behaviour at `turn.rs:923` —
 * `get_base_instructions().await` either returns a string or surfaces an
 * error; there is no "half-built" state.
 *
 * # Slice fence
 *
 * Imports `./hash.ts` (which imports `node:crypto`) and `./types.ts`. No
 * cross-slice imports.
 */

import { sha256Hex } from "./hash"
import type { SystemPromptCachePort } from "./port"
import type { CachedPrompt, CacheStats, InvalidationReason, SystemPromptCacheKey } from "./types"

/** Options for {@link createInMemorySystemPromptCache}. All optional —
 *  production callers can ignore. */
export interface InMemorySystemPromptCacheOptions {
  /** Clock seam. Defaults to {@link Date.now}. Replay / test code injects
   *  a frozen / virtual clock here so `builtAt` is deterministic. */
  readonly now?: () => number
  /** Observability sink. Called once per invalidation (manual or via
   *  `clearAll`) so an external counter / log can attribute the drop.
   *  No-op by default. The hook is intentionally fire-and-forget; throws
   *  inside the hook are NOT caught — that's a caller bug, not a cache
   *  bug. */
  readonly onInvalidate?: (key: SystemPromptCacheKey, reason: InvalidationReason) => void
}

/**
 * Build the default in-memory `SystemPromptCachePort`.
 *
 * Returns an object literal that satisfies the port — NOT a class — so
 * the impl type is intentionally NOT part of the public surface (same
 * pattern as ADR-0319 typed-history-event store). Callers who need
 * different semantics (LRU, multi-tier, persistence) write a different
 * adapter — this one stays minimal.
 */
export const createInMemorySystemPromptCache = (
  options: InMemorySystemPromptCacheOptions = {},
): SystemPromptCachePort => {
  const now = options.now ?? Date.now
  const onInvalidate = options.onInvalidate
  const store: Map<SystemPromptCacheKey, CachedPrompt> = new Map()
  let hits = 0
  let misses = 0
  let invalidations = 0

  const getOrBuild = (key: SystemPromptCacheKey, factory: () => string): CachedPrompt => {
    const existing = store.get(key)
    if (existing !== undefined) {
      hits += 1
      return existing
    }
    // Miss path. `factory` runs OUTSIDE any partial write — if it throws,
    // we leave `store` / counters untouched and the throw propagates.
    const text = factory()
    const entry: CachedPrompt = {
      key,
      text,
      builtAt: now(),
      contentHash: sha256Hex(text),
    }
    store.set(key, entry)
    misses += 1
    return entry
  }

  const peek = (key: SystemPromptCacheKey): CachedPrompt | null => {
    const existing = store.get(key)
    return existing !== undefined ? existing : null
  }

  const invalidate = (key: SystemPromptCacheKey, reason: InvalidationReason): void => {
    const removed = store.delete(key)
    if (!removed) return
    invalidations += 1
    if (onInvalidate !== undefined) onInvalidate(key, reason)
  }

  const clearAll = (reason: InvalidationReason): void => {
    if (store.size === 0) return
    // Collect keys BEFORE clearing so the hook sees one call per key.
    const keys: SystemPromptCacheKey[] = []
    for (const k of store.keys()) keys.push(k)
    store.clear()
    invalidations += keys.length
    if (onInvalidate !== undefined) {
      for (const k of keys) onInvalidate(k, reason)
    }
  }

  const stats = (): CacheStats => ({
    hits,
    misses,
    invalidations,
    size: store.size,
  })

  return { getOrBuild, peek, invalidate, clearAll, stats }
}
