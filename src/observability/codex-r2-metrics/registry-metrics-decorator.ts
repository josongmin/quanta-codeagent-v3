/**
 * ADR-0352 — `withRegistryMetrics` — wrap a SessionResourceRegistry to
 * emit getOrCreate hit/miss + size gauge + evictions counter.
 *
 * Each port method preserves return value verbatim. NO-THROW: emitter
 * exceptions swallowed.
 */
import type { SessionResourceRegistry, SessionResources } from "@/agent/session-resource-registry"
import type { CodexR2MetricsConfig } from "./types"

const safeEmit = (fn: () => void): void => {
  try {
    fn()
  } catch {
    // best-effort
  }
}

/** Wrap a SessionResourceRegistry so getOrCreate distinguishes
 *  hits/misses and evict / clear emit eviction counters. The size gauge
 *  is updated AFTER every mutation so a /metrics dashboard sees the
 *  live registry footprint. */
export const withRegistryMetrics = (
  inner: SessionResourceRegistry,
  cfg: CodexR2MetricsConfig,
): SessionResourceRegistry => {
  const prefix = cfg.prefix ?? "codex_r2"
  const reg = `${prefix}.registry`
  const emit = cfg.emitter

  return {
    getOrCreate(sessionId: string): SessionResources {
      const had = inner.peek(sessionId)
      const out = inner.getOrCreate(sessionId)
      safeEmit(() => {
        if (had === null) emit.counter(`${reg}.misses`, 1)
        else emit.counter(`${reg}.hits`, 1)
        emit.gauge(`${reg}.size`, inner.size())
      })
      return out
    },
    peek(sessionId: string): SessionResources | null {
      const out = inner.peek(sessionId)
      safeEmit(() => {
        if (out === null) emit.counter(`${reg}.peek_misses`, 1)
        else emit.counter(`${reg}.peek_hits`, 1)
      })
      return out
    },
    evict(sessionId: string): void {
      const before = inner.peek(sessionId)
      inner.evict(sessionId)
      safeEmit(() => {
        if (before !== null) {
          emit.counter(`${reg}.evictions`, 1)
          emit.gauge(`${reg}.size`, inner.size())
        }
      })
    },
    size(): number {
      const n = inner.size()
      safeEmit(() => emit.gauge(`${reg}.size`, n))
      return n
    },
    clear(): void {
      const sizeBefore = inner.size()
      inner.clear()
      safeEmit(() => {
        if (sizeBefore > 0) emit.counter(`${reg}.evictions`, sizeBefore, { reason: "clear" })
        emit.gauge(`${reg}.size`, 0)
      })
    },
    /** ADR-0386 — read-only enumerate, telemetry pass-through.
     *  We emit a `list_calls` counter so an operator can spot bulk-evict
     *  thrash + dashboards can ratio it against `evictions`. The inner
     *  call return is passed through verbatim. */
    listSessionIds(): readonly string[] {
      const ids = inner.listSessionIds()
      safeEmit(() => emit.counter(`${reg}.list_calls`, 1))
      return ids
    },
  }
}
