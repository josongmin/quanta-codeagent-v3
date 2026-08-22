/**
 * Preset: semantic → rerank pipeline. ADR-0265 §4 #4.
 *
 * Vector search produces a coarse candidate set; a cross-encoder reranker
 * re-scores the top-k before returning. Pure assembly — no concrete adapter
 * here; the reranker comes from the caller.
 */

import { compose } from "./compose"
import type {
  EmbedBatcher,
  EmbedCache,
  Embedder,
  Reranker,
  SearchPipeline,
  SemanticIndex,
  Stage,
} from "./types"

export interface SemanticThenRerankOpts {
  readonly sem: SemanticIndex
  readonly embedder: Embedder
  readonly reranker: Reranker
  readonly cache?: EmbedCache
  readonly batcher?: EmbedBatcher
}

export const semanticThenRerankPipeline = (opts: SemanticThenRerankOpts): SearchPipeline => {
  const sem: Stage = {
    kind: "semantic",
    impl: opts.sem,
    embedder: opts.embedder,
    ...(opts.cache !== undefined ? { cache: opts.cache } : {}),
    ...(opts.batcher !== undefined ? { batcher: opts.batcher } : {}),
  }
  return compose([{ kind: "rerank", impl: opts.reranker, inner: sem }])
}
