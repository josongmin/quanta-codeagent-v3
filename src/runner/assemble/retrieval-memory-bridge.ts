/**
 * Memory ↔ Retrieval bridge — surface-agnostic adapter that runs memory
 * recall through the ADR-0159 retrieval stack WITHOUT touching `@/memory`'s
 * slice (which is forbidden from importing `@/retrieval` per the RFC §3.1
 * fence: memory may only reach @/storage + @/shared).
 *
 * Default-OFF discipline: when `stack` is `undefined`, this module returns
 * the legacy `rankEntries(...)` output unchanged — byte-identical for every
 * existing caller (the recall path that does NOT opt into the retrieval
 * stack pays zero cost).
 *
 * Design:
 *   - Memory ranking stays UNTOUCHED (no edit to `src/memory/ranking.ts`).
 *     This bridge consumes the public `rankEntries` + `MemoryEntry` exports
 *     and feeds the ordered result into the retrieval funnel.
 *   - The retrieval stack is treated as a final-stage reranker over an
 *     already-ranked memory candidate list. Two-stage: stage 1 is the
 *     `rankEntries` weighted-sum (cosine + lexical + tag + freshness +
 *     importance + access + tier); stage 2 is `stack.defaultReranker` over
 *     the result, with `query.text` as the rerank query.
 *   - The bridge is PURE — same `(candidates, query, now)` inputs always
 *     produce the same output (modulo the rerank port's own determinism).
 */
import type { MemoryEntry, MemoryQuery, NormalizedEntry } from "@/memory"
import { rankEntries } from "@/memory"
import type { RetrievalCandidate } from "@/retrieval"
import type { RetrievalStack } from "./retrieval"

/** Convert a {@link NormalizedEntry} to a {@link RetrievalCandidate}. The
 *  entry's lexical score is folded into `score` and the original `id`/`text`
 *  carry through. Source is `external` because the retrieval stack did not
 *  produce this list — memory ranking did. */
const toRetrievalCandidate = (
  entry: NormalizedEntry,
  baseScore: number,
): RetrievalCandidate => ({
  id: entry.id,
  text: entry.text,
  score: baseScore,
  source: "external",
  metadata: { tier: entry.tier, importance: entry.importance },
})

/** Map a re-ranked candidate list back to the original {@link NormalizedEntry}
 *  shape. Looks up by `id` against the input ranking so a reranker that
 *  re-sorts or trims preserves the entry data. Candidates with no matching
 *  entry are dropped (defensive: a reranker SHOULD only emit subsets of its
 *  input, but the bridge tolerates malformed reranker output rather than
 *  throwing in the recall hot path). */
const reorderEntriesByCandidates = (
  ranked: readonly NormalizedEntry[],
  reordered: readonly RetrievalCandidate[],
): NormalizedEntry[] => {
  const byId = new Map<string, NormalizedEntry>()
  for (const e of ranked) byId.set(e.id, e)
  const out: NormalizedEntry[] = []
  for (const c of reordered) {
    const e = byId.get(c.id)
    if (e !== undefined) out.push(e)
  }
  return out
}

/**
 * Run memory recall, then route through the retrieval stack's default
 * reranker. The query's `text` field is the rerank query (so the reranker
 * can rescore by lexical/semantic similarity to the user's request).
 *
 * `stack` absent ⇒ this function is a transparent passthrough returning
 * `rankEntries(...)` verbatim (byte-identical to a direct call).
 *
 * `stack` present ⇒ two-stage:
 *   1. `rankEntries` produces the candidate list with the weighted-sum
 *      score (cosine + lexical + tag + freshness + importance + access).
 *   2. `stack.defaultReranker.rerank(...)` re-scores + re-orders the list.
 *      The reranker's `limit` is respected; if the rerank port returns more
 *      entries than `query.limit`, the result is clipped to `query.limit`
 *      so callers' caps are honored.
 */
export const rankWithRetrievalStack = async (
  candidates: readonly MemoryEntry[],
  query: MemoryQuery,
  now: number,
  stack: RetrievalStack | undefined,
): Promise<NormalizedEntry[]> => {
  // Stage 1: always run memory's weighted-sum ranking. Even with a stack,
  // we need the score + filtering pass first (the reranker only sees
  // candidates that passed memory's hard filters: kinds/tiers/tags/freshness/
  // minImportance/supersededBy).
  const ranked = rankEntries(candidates, query, now)
  if (stack === undefined || ranked.length === 0) return ranked
  // Stage 2: route through the chosen reranker. Use ordinal as base score
  // (rank-position-only) so the reranker decides ordering from `query.text`
  // similarity rather than re-using memory's weighted score (which would
  // dominate). 1 / (rank + 1) is the same prior shape RRF uses — neutral.
  const rerankInput = ranked.map((e, i) => toRetrievalCandidate(e, 1 / (i + 1)))
  const reordered = await stack.defaultReranker.rerank({
    query: query.text ?? "",
    candidates: rerankInput,
    ...(typeof query.limit === "number" ? { limit: query.limit } : {}),
  })
  return reorderEntriesByCandidates(ranked, reordered)
}
