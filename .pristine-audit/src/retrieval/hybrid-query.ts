/**
 * Hybrid query — 3-stage retrieval funnel.
 *
 * Stage 1: run the source(s) the query type asks for
 *   - `keywords`   → BM25 source only
 *   - `embeddings` → embedding source only
 *   - `hybrid`     → both
 *
 * Stage 2: if both ran, fuse with RRF (Cormack 2009 k=60). Score-fusion is
 * a SEPARATE reranker but the funnel composes them here so the caller only
 * has to think about "I want hybrid retrieval" not "I want to chain RRF
 * after my two sources".
 *
 * Stage 3: if a final-stage `rerank` is supplied, run it over the fused
 * (or single-source) list.
 *
 * Pure orchestration — no I/O of its own. Sources are injected callbacks;
 * the rerank port is injected. Deterministic given deterministic sources.
 */
import { fuseByRrf } from "./rerank/score-fusion-rrf"
import type { RerankPort, RetrievalCandidate } from "./types"

export type QueryType = "keywords" | "embeddings" | "hybrid"

export interface HybridQueryInput {
  readonly query: string
  readonly type: QueryType
  /** First-stage BM25 candidate source. Called only when type is `keywords` or `hybrid`. */
  readonly bm25Source: () => Promise<readonly RetrievalCandidate[]>
  /** First-stage embedding candidate source. Called only when type is `embeddings` or `hybrid`. */
  readonly embeddingSource: () => Promise<readonly RetrievalCandidate[]>
  /** Optional final-stage reranker. */
  readonly rerank?: RerankPort
  /** Cap on final output length. */
  readonly limit?: number
}

const applyLimit = (
  cs: readonly RetrievalCandidate[],
  limit: number | undefined,
): readonly RetrievalCandidate[] => {
  if (typeof limit !== "number" || limit < 0 || limit >= cs.length) return cs
  return cs.slice(0, limit)
}

export const runHybridQuery = async (
  input: HybridQueryInput,
): Promise<readonly RetrievalCandidate[]> => {
  // Stage 1.
  let first: readonly RetrievalCandidate[] = []
  if (input.type === "keywords") {
    first = await input.bm25Source()
  } else if (input.type === "embeddings") {
    first = await input.embeddingSource()
  } else {
    // hybrid — run both, then fuse.
    const [bm25, emb] = await Promise.all([input.bm25Source(), input.embeddingSource()])
    first = fuseByRrf([bm25, emb])
  }
  // Stage 3.
  if (input.rerank !== undefined) {
    const reranked = await input.rerank.rerank({
      query: input.query,
      candidates: first,
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    })
    return reranked
  }
  return applyLimit(first, input.limit)
}
