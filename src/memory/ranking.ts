// Shared, pure recall ranking. Both InMemoryStore and SqliteStore reuse this
// so ranking semantics never diverge (RFC: "no logic duplication").
//
// Hybrid signal: a query embedding (when present) is the dominant term, so
// recall is robust to paraphrase — a text miss no longer kills a vector hit.
// Lexical / tag / freshness / importance / access reinforcement refine within.

import type { MemoryTelemetryPort } from "./telemetry-port"
import {
  bucketOf,
  DEFAULT_RECALL_LIMIT,
  EMBED_DIM,
  type FreshnessBucket,
  type MemoryEntry,
  type MemoryQuery,
  type MemoryTier,
  type NormalizedEntry,
  normalizeEntry,
} from "./types"
import { cosine } from "./vector"

/** Vector similarity weight. Dominant signal — drives paraphrase-robust recall. */
const W_VEC = 10
/** Points for a case-insensitive text substring hit. */
const W_TEXT = 5
/** Extra points when entry text equals the query text exactly (whole-string). */
const W_TEXT_EXACT = 1
/** Points per overlapping query tag. */
const W_TAG = 4
/** Importance multiplier ([0,1] importance → up to this many points). */
const W_IMPORTANCE = 4
/** Cap on the access-reinforcement bonus (log1p(accessCount) clamped here). */
const ACCESS_CAP = 3
/** Tier-weight multiplier (durable semantic knowledge outranks raw episodic recap). */
const W_TIER = 2
/**
 * §10.6 routing-meta contributions. Deliberately SMALL — routing is a *refine*
 * (a soft tiebreak/boost among otherwise-comparable candidates), never a signal
 * that dominates a real vector hit (W_VEC=10). Codex treats `Task Group` /
 * `applies_to` as retrieval anchors, not as the primary relevance signal.
 */
/** Points when the entry's `taskGroup` exactly matches the query's (case-insensitive). */
const W_ROUTE_GROUP = 4
/** Points when the entry's `appliesTo.cwd` exactly matches the query's cwd. */
const W_ROUTE_CWD_EXACT = 4
/** Points when the entry cwd and query cwd are in the same family (one prefixes the other). */
const W_ROUTE_CWD_FAMILY = 2

/**
 * Tier contribution to score, by tier. Semantic (distilled, durable knowledge)
 * ranks above episodic (raw per-session recap) when all else ties — final
 * points = `TIER_WEIGHT[tier] * W_TIER`.
 */
const TIER_WEIGHT: Record<MemoryTier, number> = {
  semantic: 1,
  episodic: 0.5,
}

/** Freshness contribution to score, by bucket. Fresher ranks higher. */
const FRESHNESS_WEIGHT: Record<FreshnessBucket, number> = {
  fresh: 3,
  recent: 2,
  stale: 1,
  archived: 0,
}

const lc = (s: string): string => s.toLowerCase()

/**
 * Hard filters. `query.text` is NO LONGER a hard filter (it only scores) —
 * this removes the old paraphrase-kills-recall bug. `query.tags` IS still a
 * hard filter (≥1 tag overlap required when provided); `want` is the query's
 * precomputed lower-cased tag set (built once by the caller — see
 * {@link tagWantSet} — so the filter does not rebuild it per candidate).
 */
const passesFilters = (
  e: NormalizedEntry,
  query: MemoryQuery,
  now: number,
  want: ReadonlySet<string>,
): boolean => {
  if (e.supersededBy && !query.includeSuperseded) return false
  if (query.kinds && query.kinds.length > 0 && !query.kinds.includes(e.kind)) {
    return false
  }
  if (query.tiers && query.tiers.length > 0 && !query.tiers.includes(e.tier)) {
    return false
  }
  if (want.size > 0 && !e.tags.some((t) => want.has(lc(t)))) {
    return false
  }
  if (
    query.freshness &&
    query.freshness.length > 0 &&
    !query.freshness.includes(bucketOf(now - e.createdAt))
  ) {
    return false
  }
  if (typeof query.minImportance === "number" && e.importance < query.minImportance) {
    return false
  }
  return true
}

/** Clamped cosine contribution (0 unless both embeddings are full-dim). */
const vectorScore = (e: NormalizedEntry, query: MemoryQuery): number => {
  if (
    !query.embedding ||
    query.embedding.length !== EMBED_DIM ||
    !e.embedding ||
    e.embedding.length !== EMBED_DIM
  ) {
    return 0
  }
  const c = cosine(query.embedding, e.embedding)
  return (c < 0 ? 0 : c > 1 ? 1 : c) * W_VEC
}

/** Lexical contribution: substring hit, plus exact whole-string bonus. */
const textScore = (e: NormalizedEntry, query: MemoryQuery): number => {
  if (!query.text || query.text.length === 0) return 0
  const hay = lc(e.text)
  const needle = lc(query.text)
  if (!hay.includes(needle)) return 0
  return hay === needle ? W_TEXT + W_TEXT_EXACT : W_TEXT
}

/** Lower-cased query-tag set. Depends ONLY on the query, so `rankEntries`
 *  builds it ONCE and threads it to every candidate's `tagScore` — building a
 *  fresh Set per candidate (recall runs every turn over 100+ candidates) was
 *  pure waste. */
const tagWantSet = (query: MemoryQuery): ReadonlySet<string> => new Set((query.tags ?? []).map(lc))

/** Tag-overlap contribution: W_TAG per shared (case-insensitive) tag. `want` is
 *  the precomputed query-tag set (see {@link tagWantSet}); counts overlap with
 *  no intermediate Set allocation. */
const tagScore = (e: NormalizedEntry, want: ReadonlySet<string>): number => {
  if (want.size === 0) return 0
  let overlap = 0
  for (const t of e.tags) if (want.has(lc(t))) overlap++
  return overlap * W_TAG
}

/**
 * §10.6 — true iff `a` and `b` are in the same checkout family: identical, or
 * one is a path-prefix of the other AT A SEGMENT BOUNDARY (so `/a/b` and
 * `/a/bc` are NOT family — only `/a/b` and `/a/b/c`). Trailing slashes are
 * normalized. Pure; case-sensitive (paths are).
 */
const sameCwdFamily = (a: string, b: string): boolean => {
  const norm = (s: string): string => (s.length > 1 && s.endsWith("/") ? s.slice(0, -1) : s)
  const x = norm(a)
  const y = norm(b)
  if (x === y) return true
  const [shorter, longer] = x.length < y.length ? [x, y] : [y, x]
  // longer must start with `shorter` followed by a path separator (segment
  // boundary) — guards the `/a/b` vs `/a/bc` false-positive.
  return longer.startsWith(`${shorter}/`)
}

/**
 * §10.6 routing-meta contribution. ZERO unless `query.routing` is present AND
 * the entry's routing meta matches — so a query that does not opt into routing
 * (the default) scores byte-identically to the legacy weighted-sum. cwd boost
 * is exact-OR-family (never both): an exact match supersedes the family bonus.
 */
const routingScore = (e: NormalizedEntry, query: MemoryQuery): number => {
  const r = query.routing
  if (!r) return 0
  let s = 0
  if (r.taskGroup && e.taskGroup && lc(r.taskGroup) === lc(e.taskGroup)) {
    s += W_ROUTE_GROUP
  }
  if (r.cwd && e.appliesTo?.cwd) {
    if (r.cwd === e.appliesTo.cwd) s += W_ROUTE_CWD_EXACT
    else if (sameCwdFamily(r.cwd, e.appliesTo.cwd)) s += W_ROUTE_CWD_FAMILY
  }
  return s
}

/** Weighted-sum relevance score for an entry that passed the filters. `want` is
 *  the query's precomputed tag set (caller hoists it out of the candidate loop). */
const scoreOf = (
  e: NormalizedEntry,
  query: MemoryQuery,
  now: number,
  want: ReadonlySet<string>,
): number =>
  vectorScore(e, query) +
  textScore(e, query) +
  tagScore(e, want) +
  FRESHNESS_WEIGHT[bucketOf(now - e.createdAt)] +
  e.importance * W_IMPORTANCE +
  Math.min(Math.log1p(e.accessCount), ACCESS_CAP) +
  TIER_WEIGHT[e.tier] * W_TIER +
  routingScore(e, query)

/**
 * Pure, exported score-of-one helper (ADR-0082 memory_citation provenance).
 * Returns the SAME deterministic weighted-sum score `rankEntries` uses
 * internally, for callers that already received the ranked entries from
 * `PersistentStorePort.recall` and want to annotate them with the score that
 * placed them. Normalizes the entry on the way in so callers can pass either
 * a raw `MemoryEntry` (store boundary) or a `NormalizedEntry` (post-rank).
 */
export const scoreEntry = (
  entry: MemoryEntry,
  query: MemoryQuery,
  now: number = Date.now(),
): number => scoreOf(normalizeEntry(entry), query, now, tagWantSet(query))

/**
 * Filter + rank a candidate list. Pure and deterministic. Operates on
 * normalized entries. Sort: score desc, then importance desc, then updatedAt
 * desc, then createdAt desc, then id desc (total + deterministic). `now` is
 * injectable for deterministic tests.
 *
 * Telemetry (S6-Memory, optional): when `telemetry` is provided, emits a
 * single {@link RecallTelemetryEvent} on the way out carrying ONLY
 * `{hits, totalScanned, latencyMs}` — entry text, per-entry score, query
 * text, and the ranked list itself NEVER cross this seam. With `telemetry`
 * undefined, the rank path is byte-identical to the legacy behavior.
 */
export const rankEntries = (
  candidates: readonly MemoryEntry[],
  query: MemoryQuery,
  now: number = Date.now(),
  telemetry?: MemoryTelemetryPort,
): NormalizedEntry[] => {
  // performance.now() vs Date.now(): the latency value is a duration, NOT a
  // wall-clock — `performance.now()` is monotonic and avoids the `now`
  // injection coupling (callers pin `now` for deterministic scoring but
  // wall-clock during the same call is still real).
  const startMs = performance.now()
  const limit = query.limit ?? DEFAULT_RECALL_LIMIT
  if (limit <= 0) {
    if (telemetry) {
      try {
        telemetry.recordRecall({
          hits: 0,
          totalScanned: candidates.length,
          latencyMs: performance.now() - startMs,
        })
      } catch {
        /* swallow */
      }
    }
    return []
  }

  // Build the query-tag set ONCE (it is candidate-independent), then score.
  const want = tagWantSet(query)
  const scored = candidates
    .map(normalizeEntry)
    .filter((e) => passesFilters(e, query, now, want))
    .map((entry) => ({ entry, score: scoreOf(entry, query, now, want) }))

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (b.entry.importance !== a.entry.importance) {
      return b.entry.importance - a.entry.importance
    }
    if (b.entry.updatedAt !== a.entry.updatedAt) {
      return b.entry.updatedAt - a.entry.updatedAt
    }
    if (b.entry.createdAt !== a.entry.createdAt) {
      return b.entry.createdAt - a.entry.createdAt
    }
    return b.entry.id < a.entry.id ? -1 : b.entry.id > a.entry.id ? 1 : 0
  })

  const result = scored.slice(0, limit).map((s) => s.entry)
  if (telemetry) {
    try {
      telemetry.recordRecall({
        hits: result.length,
        totalScanned: candidates.length,
        latencyMs: performance.now() - startMs,
      })
    } catch {
      /* swallow */
    }
  }
  return result
}
