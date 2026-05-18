// Shared, pure recall ranking. Both InMemoryStore and SqliteStore reuse this
// so ranking semantics never diverge (RFC: "no logic duplication").

import {
  bucketOf,
  DEFAULT_RECALL_LIMIT,
  type FreshnessBucket,
  type MemoryEntry,
  type MemoryQuery,
} from "./types"

/** Freshness contribution to score, by bucket. Fresher ranks higher. */
const FRESHNESS_WEIGHT: Record<FreshnessBucket, number> = {
  fresh: 3,
  recent: 2,
  stale: 1,
  archived: 0,
}

/** Points per overlapping query tag. */
const TAG_MATCH_WEIGHT = 4
/** Points for a case-insensitive text substring hit. */
const TEXT_MATCH_WEIGHT = 5

const norm = (s: string): string => s.toLowerCase()

/** Does the entry pass the query's hard filters (kind / tag / text / freshness)? */
const passesFilters = (entry: MemoryEntry, query: MemoryQuery, now: number): boolean => {
  if (query.kinds && query.kinds.length > 0 && !query.kinds.includes(entry.kind)) {
    return false
  }
  if (query.tags && query.tags.length > 0) {
    const want = new Set(query.tags.map(norm))
    if (!entry.tags.some((t) => want.has(norm(t)))) return false
  }
  if (query.text && query.text.length > 0) {
    if (!norm(entry.text).includes(norm(query.text))) return false
  }
  if (query.freshness && query.freshness.length > 0) {
    if (!query.freshness.includes(bucketOf(now - entry.createdAt))) return false
  }
  return true
}

/** Relevance score for an entry already known to pass the filters. */
const scoreOf = (entry: MemoryEntry, query: MemoryQuery, now: number): number => {
  let score = FRESHNESS_WEIGHT[bucketOf(now - entry.createdAt)]

  if (query.tags && query.tags.length > 0) {
    const want = new Set(query.tags.map(norm))
    const overlap = new Set(entry.tags.map(norm).filter((t) => want.has(t)))
    score += overlap.size * TAG_MATCH_WEIGHT
  }

  if (query.text && query.text.length > 0) {
    const hay = norm(entry.text)
    const needle = norm(query.text)
    if (hay.includes(needle)) {
      score += TEXT_MATCH_WEIGHT
      // Reward a whole-string match a touch more for determinism on ties.
      if (hay === needle) score += 1
    }
  }

  return score
}

/**
 * Filter + rank a candidate list. Pure and deterministic:
 * higher score first, tie-break by `createdAt` desc, then `id` desc.
 * `now` is injectable for deterministic tests.
 */
export const rankEntries = (
  candidates: readonly MemoryEntry[],
  query: MemoryQuery,
  now: number = Date.now(),
): MemoryEntry[] => {
  const limit = query.limit ?? DEFAULT_RECALL_LIMIT
  if (limit <= 0) return []

  const scored = candidates
    .filter((e) => passesFilters(e, query, now))
    .map((entry) => ({ entry, score: scoreOf(entry, query, now) }))

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (b.entry.createdAt !== a.entry.createdAt) return b.entry.createdAt - a.entry.createdAt
    return b.entry.id < a.entry.id ? -1 : b.entry.id > a.entry.id ? 1 : 0
  })

  return scored.slice(0, limit).map((s) => s.entry)
}
