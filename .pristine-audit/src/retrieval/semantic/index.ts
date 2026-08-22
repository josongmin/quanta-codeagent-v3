/**
 * `@/retrieval/semantic` — slice barrel (ADR-0254).
 *
 * Semantic-search primitive reduced to its live surface: the `Embedder`
 * port + a deterministic headless adapter. The dead text-in `SemanticIndex`
 * port and its in-memory cosine adapter were removed as a proven duplicate
 * of the live vector-in `SemanticIndex` in `@/retrieval/pipeline` (the real
 * search wire's port). Default-OFF — the only src/ consumer is
 * `src/runner/assemble/pipeline.ts`, which pulls `createHeadlessEmbedder`.
 */

export type { Embedder, EmbedError } from "./embed-port"
export type { HeadlessEmbedderOptions } from "./headless-embedder"
export { createHeadlessEmbedder } from "./headless-embedder"
export type { EmbeddingVector } from "./types"
