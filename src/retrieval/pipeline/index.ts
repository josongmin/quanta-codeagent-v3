/**
 * `@/retrieval/pipeline` sub-barrel — ADR-0265.
 *
 * Public surface: the `compose()` DAG composer, the 5 pre-built presets, and
 * the Stage / Port / Error types. Sibling files in `src/retrieval/*` (lexical
 * / semantic / reranker / cache / batching) are NOT imported here — every
 * join is duck-typed via `types.ts`. The slice fence (ADR-0159) is enforced
 * by biome `noRestrictedImports`.
 */

export { type BudgetAwareOpts, budgetAwarePipeline } from "./budget-aware"
export { compose, RRF_K } from "./compose"
export { type LexicalOnlyOpts, lexicalOnlyPipeline } from "./lexical-only"
export { type ParallelRrfOpts, parallelRrfPipeline } from "./parallel-rrf"
export type { SearchPipeline } from "./port"
export { type SemanticOnlyOpts, semanticOnlyPipeline } from "./semantic-only"
export {
  type SemanticThenRerankOpts,
  semanticThenRerankPipeline,
} from "./semantic-then-rerank"
export type {
  BudgetProbe,
  EmbedBatcher,
  EmbedCache,
  Embedder,
  LexicalSearch,
  PipelineError,
  Reranker,
  SearchHit,
  SearchQuery,
  SemanticIndex,
  Stage,
} from "./types"
