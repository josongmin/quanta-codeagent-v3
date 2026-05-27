/**
 * ADR-0352 — `withCacheMetrics` — wrap a SystemPromptCachePort to emit
 * hit/miss/invalidation counters as they happen.
 *
 * Each method preserves return value verbatim (byte-identical). NO-THROW:
 * emitter exceptions are swallowed so observability instrumentation
 * cannot break the cache path.
 */
import type {
  CachedPrompt,
  CacheStats,
  InvalidationReason,
  SystemPromptCacheKey,
  SystemPromptCachePort,
} from "@/llm/system-prompt-cache"
import type { CodexR2MetricsConfig } from "./types"

const safeEmit = (fn: () => void): void => {
  try {
    fn()
  } catch {
    // emitter is best-effort — NEVER throw out of this wrapper
  }
}

/** Wrap a SystemPromptCachePort so each port method fires a counter on
 *  the supplied emitter. `peek` is split into peek_hits / peek_misses
 *  so polling consumers (debug UI, /metrics admin) do not confuse a
 *  hot key with a builder miss. `clearAll` emits a single counter
 *  whose delta equals the number of entries that were dropped. */
export const withCacheMetrics = (
  inner: SystemPromptCachePort,
  cfg: CodexR2MetricsConfig,
): SystemPromptCachePort => {
  const prefix = cfg.prefix ?? "codex_r2"
  const cache = `${prefix}.cache`
  const emit = cfg.emitter

  return {
    getOrBuild(key: SystemPromptCacheKey, factory: () => string): CachedPrompt {
      const before = inner.peek(key)
      const out = inner.getOrBuild(key, factory)
      safeEmit(() => {
        if (before === null) emit.counter(`${cache}.misses`, 1)
        else emit.counter(`${cache}.hits`, 1)
      })
      return out
    },
    peek(key: SystemPromptCacheKey): CachedPrompt | null {
      const out = inner.peek(key)
      safeEmit(() => {
        if (out === null) emit.counter(`${cache}.peek_misses`, 1)
        else emit.counter(`${cache}.peek_hits`, 1)
      })
      return out
    },
    invalidate(key: SystemPromptCacheKey, reason: InvalidationReason): void {
      const before = inner.peek(key)
      inner.invalidate(key, reason)
      safeEmit(() => {
        if (before !== null) emit.counter(`${cache}.invalidations`, 1, { reason })
      })
    },
    clearAll(reason: InvalidationReason): void {
      const sizeBefore = inner.stats().size
      inner.clearAll(reason)
      safeEmit(() => {
        if (sizeBefore > 0) emit.counter(`${cache}.invalidations`, sizeBefore, { reason })
      })
    },
    stats(): CacheStats {
      const s = inner.stats()
      safeEmit(() => {
        emit.gauge(`${cache}.size`, s.size)
      })
      return s
    },
  }
}
