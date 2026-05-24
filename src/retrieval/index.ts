/**
 * `@/retrieval` slice barrel — ADR-0159.
 *
 * Five axes, exposed as a single surface so assemblers in `@/agent` wire one
 * import path. Adapters live INSIDE the slice (every adapter is "compose
 * vendor X with our generic port" — no slice-isolation conflict the way
 * `@/memory` ↔ openai had).
 */

export type { ChunkBucket, ChunkBucketOptions, TokenizerPort } from "./chunk-bucket"
// Chunk-bucket re-chunker (Axis B).
export {
  BUCKET_TOKENS,
  DEFAULT_OVERLAP_RATIO,
  rechunk,
} from "./chunk-bucket"
export type {
  CommitEmbedder,
  CommitEmbedderOptions,
  CommitNote,
  CommitNoteWithEmbedding,
  GitLogPort,
} from "./commit-embedder"
// Commit embedder (Axis C).
export { createCommitEmbedder } from "./commit-embedder"
export type { CohereEmbedderOptions } from "./embedders/cohere"
export { createCohereEmbedder } from "./embedders/cohere"
export type { GeminiEmbedderOptions } from "./embedders/gemini"
export { createGeminiEmbedder } from "./embedders/gemini"
export type { MoonshotEmbedderOptions } from "./embedders/moonshot"
export { createMoonshotEmbedder } from "./embedders/moonshot"
export type { NvidiaEmbedderOptions } from "./embedders/nvidia"
export { createNvidiaEmbedder } from "./embedders/nvidia"
export type { EmbeddingsHttp, OpenAIRetrievalEmbedderOptions } from "./embedders/openai"
export { createOpenAIEmbedder } from "./embedders/openai"
export type { VoyageEmbedderOptions, VoyageHttp } from "./embedders/voyage"
export { createVoyageEmbedder } from "./embedders/voyage"
export type { XaiEmbedderOptions } from "./embedders/xai"
export { createXaiEmbedder } from "./embedders/xai"
export type { ZaiEmbedderOptions } from "./embedders/zai"
export { createZaiEmbedder } from "./embedders/zai"
// Multi-vendor embedding port (Axis D) — port + 8 adapter factories.
export type { EmbeddingAdapterOptions, EmbeddingPort, EmbeddingVendor } from "./embedding-port"
export type { HybridQueryInput, QueryType } from "./hybrid-query"
// Hybrid query funnel (Axis E).
export { runHybridQuery } from "./hybrid-query"
export type { Bm25SecondaryOptions } from "./rerank/bm25-secondary"
export { createBm25SecondaryReranker } from "./rerank/bm25-secondary"
export { identityReranker } from "./rerank/identity"
export {
  fuseByRrf,
  RRF_K,
  rrfReranker,
} from "./rerank/score-fusion-rrf"
export type {
  CandidateTier,
  TierAwareOptions,
  TierClassifierPort,
} from "./rerank/tier-aware"
export {
  createTierAwareReranker,
  DEFAULT_TIER_PENALTY,
} from "./rerank/tier-aware"
// Reranker registry + 4 built-in strategies (Axis A).
export { RerankRegistry } from "./rerank-registry"
// Core types.
export type {
  RerankerKind,
  RerankInput,
  RerankPort,
  RetrievalCandidate,
} from "./types"
export { RetrievalError } from "./types"
