/**
 * `@/retrieval/batching` barrel (ADR-0264).
 *
 * Surfaces the closed {@link EmbedBatcher} port, the production
 * {@link createDefaultBatcher} factory, the pure {@link createSingleFlight}
 * helper, and the public types ({@link EmbeddingVector}, {@link BatchConfig},
 * {@link BatchError}).
 *
 * The slice is intentionally NOT re-exported from `src/retrieval/index.ts`
 * — that top-level barrel is on the unchanged constraint list for this round.
 * Callers import directly from `@/retrieval/batching`.
 */

export type { DefaultBatcherOptions, UnderlyingEmbedder } from "./default-batcher"
export { createDefaultBatcher } from "./default-batcher"
export type { EmbedBatcher } from "./port"
export type { SingleFlight } from "./single-flight"
export { createSingleFlight } from "./single-flight"
export type { BatchConfig, BatchError, EmbeddingVector } from "./types"
