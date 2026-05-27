/**
 * ADR-0345 — Default in-memory `SessionResourceRegistry` adapter.
 *
 * Backed by a `Map<sessionId, { resources, lastTouched }>` so insertion
 * order is preserved (matters for LRU tie-breaking — Map iteration is
 * insertion-order which doubles as the secondary key when multiple
 * entries share an exact `lastTouched`).
 *
 * # Implementation notes
 *
 * - The internal factories (`createInMemoryTypedHistoryEventStore` /
 *   `createInMemorySystemPromptCache`) are imported eagerly. The slice
 *   pays a tiny import-time cost; in exchange, composition roots that
 *   adopt the registry get the standard defaults with zero extra
 *   plumbing.
 *
 * - `getOrCreate` is implemented as: (1) TTL sweep, (2) lookup → hit
 *   ⇒ touch + return, (3) miss ⇒ create + insert + LRU sweep + return.
 *   Steps (1) and (3) are conditional on the matching config slot
 *   being set, so an unconfigured registry pays only the lookup cost.
 *
 * - Every public method wraps in try/catch and degrades to a sensible
 *   no-op on failure (NO-THROW). The internal factories should never
 *   throw, but a hostile mock could; defense-in-depth.
 *
 * - `peek` is deliberately READ-ONLY: it sweeps for TTL evictions
 *   (since a TTL-expired entry should be invisible) but does NOT
 *   bump `lastTouched`. This mirrors the existing `SystemPromptCachePort.peek`
 *   contract (`src/llm/system-prompt-cache/port.ts:62-63`) where peek
 *   is explicitly stat-only.
 *
 * Closed-port DIP: this impl is the contract reference for
 * `SessionResourceRegistry`. Any alternate adapter (disk, distributed)
 * must pass every assertion in `__tests__/registry.hellgate.test.ts`.
 */

import { createInMemorySystemPromptCache } from "@/llm/system-prompt-cache"
import { createInMemoryTypedHistoryEventStore } from "@/memory/typed-event"
import type { RegistryConfig, SessionResourceRegistry, SessionResources } from "./types"

interface Entry {
  resources: SessionResources
  lastTouched: number
}

/** Mint a fresh resources pair. Isolated for testability / future
 *  swap-out (e.g. a disk-backed factory in a follow-up ADR). */
const mintResources = (): SessionResources => ({
  store: createInMemoryTypedHistoryEventStore(),
  cache: createInMemorySystemPromptCache(),
})

class InMemorySessionResourceRegistry implements SessionResourceRegistry {
  private readonly entries = new Map<string, Entry>()
  private readonly maxEntries: number | undefined
  private readonly idleTtlMs: number | undefined
  private readonly now: () => number

  constructor(cfg: RegistryConfig | undefined) {
    this.maxEntries = cfg?.maxEntries
    this.idleTtlMs = cfg?.idleTtlMs
    this.now = cfg?.now ?? Date.now
  }

  /** Sweep TTL-expired entries. Pure no-op when `idleTtlMs` is absent. */
  private sweepTtl(currentNow: number): void {
    if (this.idleTtlMs === undefined) return
    const ttl = this.idleTtlMs
    // Snapshot keys first to avoid mutating-during-iteration footguns.
    const expired: string[] = []
    for (const [id, entry] of this.entries) {
      if (currentNow - entry.lastTouched >= ttl) expired.push(id)
    }
    for (const id of expired) this.entries.delete(id)
  }

  /** Sweep LRU overflow. Pure no-op when `maxEntries` is absent or
   *  current size is within the cap. */
  private sweepLru(): void {
    if (this.maxEntries === undefined) return
    while (this.entries.size > this.maxEntries) {
      // Map iteration is insertion-order, but we want oldest by
      // `lastTouched`. Walk once to find the minimum.
      let oldestId: string | undefined
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [id, entry] of this.entries) {
        if (entry.lastTouched < oldestAt) {
          oldestAt = entry.lastTouched
          oldestId = id
        }
      }
      if (oldestId === undefined) return
      this.entries.delete(oldestId)
    }
  }

  getOrCreate(sessionId: string): SessionResources {
    try {
      const t = this.now()
      this.sweepTtl(t)
      const hit = this.entries.get(sessionId)
      if (hit !== undefined) {
        hit.lastTouched = t
        return hit.resources
      }
      const resources = mintResources()
      this.entries.set(sessionId, { resources, lastTouched: t })
      this.sweepLru()
      return resources
    } catch {
      // NO-THROW degraded path: return a one-shot pair that nobody else
      // can reach. Caller can still use it, the registry just didn't
      // persist it.
      return mintResources()
    }
  }

  peek(sessionId: string): SessionResources | null {
    try {
      const t = this.now()
      this.sweepTtl(t)
      const hit = this.entries.get(sessionId)
      return hit?.resources ?? null
    } catch {
      return null
    }
  }

  evict(sessionId: string): void {
    try {
      this.entries.delete(sessionId)
    } catch {
      // unreachable on a healthy Map, but the catch keeps NO-THROW.
    }
  }

  size(): number {
    try {
      // Surface a post-TTL-sweep view so `size()` and a subsequent
      // `peek` cannot disagree about whether an expired entry "exists".
      this.sweepTtl(this.now())
      return this.entries.size
    } catch {
      return 0
    }
  }

  clear(): void {
    try {
      this.entries.clear()
    } catch {
      // NO-THROW.
    }
  }

  /**
   * ADR-0386 — read-only enumerate.
   *
   * Sweeps TTL before reading so an expired entry cannot appear in the
   * listing (consistent with `peek` + `size`). Returns a fresh
   * `Array.from(this.entries.keys())` so the caller cannot mutate the
   * backing Map by accident. NO-THROW.
   */
  listSessionIds(): readonly string[] {
    try {
      this.sweepTtl(this.now())
      return Array.from(this.entries.keys())
    } catch {
      return []
    }
  }
}

/**
 * Construct a fresh in-memory session-resource registry. The default
 * adapter is exported only as a factory — the class is not part of the
 * public surface (see barrel `./index.ts`).
 */
export const createInMemorySessionResourceRegistry = (
  cfg?: RegistryConfig,
): SessionResourceRegistry => new InMemorySessionResourceRegistry(cfg)
