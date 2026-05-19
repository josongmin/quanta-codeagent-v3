// Pure eviction planner for the durable store (RFC §6.3, SOTA++ memory).
// Runs as a periodic full-store sweep: bounds each tier, prunes ancient
// superseded rows, and decays long-archived low-value memories. Returns only
// ids — the caller performs the actual delete()/update() so this stays pure
// and unit-testable. Semantics shared so adapters never diverge.

import {
  bucketOf,
  type FreshnessBucket,
  type MemoryEntry,
  type MemoryTier,
  type NormalizedEntry,
  normalizeEntry,
  STALE_MAX_MS,
} from "./types"

/** Per-tier retention caps (entry counts). */
export interface EvictionCaps {
  semanticMax: number
  episodicMax: number
}

/** Default caps: semantic is the durable core, episodic is evicted faster. */
export const DEFAULT_EVICTION_CAPS: EvictionCaps = {
  semanticMax: 500,
  episodicMax: 200,
}

/** Multiplier the caller applies to `importance` of each decayed entry. */
export const EVICTION_DECAY = 0.5

/** Ids to decay (importance *= EVICTION_DECAY) and to hard-delete. Disjoint. */
export interface EvictionPlan {
  decay: string[]
  delete: string[]
}

/** Min importance for a decay to be worthwhile (else it's noise). */
const DECAY_MIN_IMPORTANCE = 0.05

/** Freshness contribution to value, by bucket (same scale as ranking). */
const FRESHNESS_WEIGHT: Record<FreshnessBucket, number> = {
  fresh: 3,
  recent: 2,
  stale: 1,
  archived: 0,
}

/** Long-term value score for an entry (drives cap-overflow ordering). */
const scoreValue = (e: NormalizedEntry, now: number): number =>
  e.importance + FRESHNESS_WEIGHT[bucketOf(now - e.createdAt)] / 3 + Math.log1p(e.accessCount) / 4

/** value desc, then createdAt desc, then id desc (total order). */
const byValueDesc = (
  a: { v: number; e: NormalizedEntry },
  b: { v: number; e: NormalizedEntry },
): number => {
  if (b.v !== a.v) return b.v - a.v
  if (b.e.createdAt !== a.e.createdAt) return b.e.createdAt - a.e.createdAt
  return b.e.id < a.e.id ? -1 : b.e.id > a.e.id ? 1 : 0
}

/** Entry paired with its long-term value, sorted descending by {@link byValueDesc}. */
type ValuedEntry = { v: number; e: NormalizedEntry }

/** Value-sorted entries of a single tier. */
const tierEntries = (
  entries: readonly MemoryEntry[],
  tier: MemoryTier,
  now: number,
): ValuedEntry[] =>
  entries
    .map(normalizeEntry)
    .filter((e) => e.tier === tier)
    .map((e) => ({ e, v: scoreValue(e, now) }))
    .sort(byValueDesc)

/**
 * Ids to delete within one (value-sorted) tier: (a) ancient superseded rows,
 * then (b) cap overflow — the lowest-value entries beyond `cap`.
 */
const tierDeletes = (inTier: ValuedEntry[], cap: number, now: number): Set<string> => {
  const deleted = new Set<string>()

  for (const { e } of inTier) {
    if (e.supersededBy && now - e.createdAt > STALE_MAX_MS) deleted.add(e.id)
  }

  let kept = 0
  for (const { e } of inTier) {
    if (deleted.has(e.id)) continue
    if (kept < cap) kept++
    else deleted.add(e.id)
  }

  return deleted
}

/** A survivor (not deleted) is decayed when archived and above the floor. */
const shouldDecay = (e: NormalizedEntry, now: number): boolean =>
  bucketOf(now - e.createdAt) === "archived" && e.importance > DECAY_MIN_IMPORTANCE

/**
 * Plan eviction over the whole store. Pure; `now` injectable. Processes the
 * `semantic` and `episodic` tiers independently:
 *
 * - delete: (a) superseded entries older than {@link STALE_MAX_MS} (30d), and
 *   (b) lowest-value entries beyond the tier cap.
 * - decay:  surviving entries in the `archived` bucket with importance above a
 *   small floor (caller multiplies their importance by {@link EVICTION_DECAY}).
 *
 * An id appears in at most one list (delete wins).
 */
export const planEviction = (
  entries: readonly MemoryEntry[],
  caps?: Partial<EvictionCaps>,
  now: number = Date.now(),
): EvictionPlan => {
  const resolved: EvictionCaps = { ...DEFAULT_EVICTION_CAPS, ...caps }
  const capByTier: Record<MemoryTier, number> = {
    semantic: resolved.semanticMax,
    episodic: resolved.episodicMax,
  }

  const del: string[] = []
  const decay: string[] = []

  for (const tier of ["semantic", "episodic"] as const) {
    const inTier = tierEntries(entries, tier, now)
    const deletedHere = tierDeletes(inTier, capByTier[tier], now)

    for (const { e } of inTier) {
      if (deletedHere.has(e.id)) del.push(e.id)
      else if (shouldDecay(e, now)) decay.push(e.id)
    }
  }

  return { decay, delete: del }
}
