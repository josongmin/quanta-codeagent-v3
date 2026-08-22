/** Preset: semantic-only (vector index) pipeline. ADR-0265 §4 #2. */

import { compose } from "./compose"
import type { EmbedBatcher, EmbedCache, Embedder, SearchPipeline, SemanticIndex } from "./types"

export interface SemanticOnlyOpts {
  readonly sem: SemanticIndex
  readonly embedder: Embedder
  readonly cache?: EmbedCache
  readonly batcher?: EmbedBatcher
}

export const semanticOnlyPipeline = (opts: SemanticOnlyOpts): SearchPipeline =>
  compose([
    {
      kind: "semantic",
      impl: opts.sem,
      embedder: opts.embedder,
      ...(opts.cache !== undefined ? { cache: opts.cache } : {}),
      ...(opts.batcher !== undefined ? { batcher: opts.batcher } : {}),
    },
  ])
