/**
 * Preset: parallel RRF fusion (lex || sem). ADR-0265 §4 #3.
 *
 * Runs lexical and semantic in parallel, then fuses with Reciprocal Rank
 * Fusion (Cormack 2009, k=60). The fused list is what the caller sees.
 */

import { compose } from "./compose"
import type {
  EmbedBatcher,
  EmbedCache,
  Embedder,
  LexicalSearch,
  SearchPipeline,
  SemanticIndex,
  Stage,
} from "./types"

export interface ParallelRrfOpts {
  readonly lex: LexicalSearch
  readonly sem: SemanticIndex
  readonly embedder: Embedder
  readonly cache?: EmbedCache
  readonly batcher?: EmbedBatcher
  /** Override the RRF k. Default 60 (Cormack 2009). */
  readonly rrfK?: number
}

export const parallelRrfPipeline = (opts: ParallelRrfOpts): SearchPipeline => {
  const semStage: Stage = {
    kind: "semantic",
    impl: opts.sem,
    embedder: opts.embedder,
    ...(opts.cache !== undefined ? { cache: opts.cache } : {}),
    ...(opts.batcher !== undefined ? { batcher: opts.batcher } : {}),
  }
  return compose([
    {
      kind: "rrf",
      inputs: [{ kind: "lexical", impl: opts.lex }, semStage],
      ...(opts.rrfK !== undefined ? { k: opts.rrfK } : {}),
    },
  ])
}
