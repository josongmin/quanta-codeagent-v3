/**
 * Reciprocal Rank Fusion (RRF) — fuse multiple ranked candidate lists into
 * one. The standard recipe from Cormack et al. 2009 ("Reciprocal Rank
 * Fusion outperforms Condorcet and individual Rank Learning Methods"):
 *
 *     RRFscore(d) = Σ_i  1 / (k + rank_i(d))
 *
 * where `k = 60` is the published constant. The reranker normalizes the
 * incoming candidates by their CURRENT order (the caller is responsible for
 * presenting each list pre-sorted), groups duplicates by `id` across lists,
 * and emits one row per id with the fused RRF score.
 *
 * Unlike a single-list reranker, RRF takes MULTIPLE lists. Because the
 * {@link RerankPort} contract takes one list, this module exposes a
 * standalone `fuseByRrf` function that the {@link RerankPort} adapter wraps
 * for the special case "the candidates carry their list-id in metadata.list".
 *
 * Pure. Deterministic.
 */
import { byteCompare } from "@/shared"
import type { RerankInput, RerankPort, RetrievalCandidate } from "../types"

/** Cormack 2009 published constant. NOT invented. [[no-heuristics-only-validated]]. */
export const RRF_K = 60

/**
 * Fuse `lists` by RRF. Each list is consumed in the order given (rank 1 = first).
 * `k` defaults to {@link RRF_K}; override only if you have a published reason.
 * Returns one row per unique id (preferring the FIRST candidate seen for that
 * id, so `text`/`source` are stable across calls with the same input shape).
 */
export const fuseByRrf = (
  lists: ReadonlyArray<readonly RetrievalCandidate[]>,
  k: number = RRF_K,
): RetrievalCandidate[] => {
  const acc = new Map<string, { rep: RetrievalCandidate; score: number }>()
  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const c = list[rank]
      if (c === undefined) continue
      const delta = 1 / (k + rank + 1)
      const prev = acc.get(c.id)
      if (prev) {
        prev.score += delta
      } else {
        acc.set(c.id, { rep: c, score: delta })
      }
    }
  }
  const out: RetrievalCandidate[] = []
  for (const { rep, score } of acc.values()) {
    out.push({ ...rep, score, source: "hybrid" })
  }
  out.sort((a, b) => (b.score !== a.score ? b.score - a.score : byteCompare(a.id, b.id)))
  return out
}

/**
 * {@link RerankPort} adapter: groups input candidates by `metadata.list`
 * (or by their `source` field if `metadata.list` is absent), then fuses
 * each group as a separate ranked list. With a single source, this collapses
 * to a no-op rerank (`1 / (k + rank + 1)` is monotone in rank).
 */
export const rrfReranker: RerankPort = {
  kind: "score-fusion-rrf",
  async rerank(input: RerankInput): Promise<readonly RetrievalCandidate[]> {
    const buckets = new Map<string, RetrievalCandidate[]>()
    for (const c of input.candidates) {
      const meta = c.metadata
      const list = meta && typeof meta.list === "string" ? meta.list : c.source
      const arr = buckets.get(list)
      if (arr) arr.push(c)
      else buckets.set(list, [c])
    }
    const lists: RetrievalCandidate[][] = []
    // Deterministic bucket order: sort by list key bytes.
    const keys = [...buckets.keys()].sort(byteCompare)
    for (const k of keys) {
      const arr = buckets.get(k)
      if (arr) lists.push(arr)
    }
    const fused = fuseByRrf(lists)
    const limit = input.limit
    if (typeof limit === "number" && limit >= 0 && limit < fused.length) {
      return fused.slice(0, limit)
    }
    return fused
  },
}
