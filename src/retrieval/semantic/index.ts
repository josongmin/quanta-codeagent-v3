/**
 * `@/retrieval/semantic` — slice barrel (ADR-0254).
 *
 * Closed-port semantic-search primitive: types + 2 ports (`SemanticIndex`,
 * `Embedder`) + 2 adapters (in-memory cosine, deterministic headless
 * embedder). Default-OFF — no other src/ module constructs anything from
 * this slice in production paths.
 */

export type { Embedder, EmbedError } from "./embed-port"
export type { HeadlessEmbedderOptions } from "./headless-embedder"
export { createHeadlessEmbedder } from "./headless-embedder"
export { createInMemoryIndex } from "./in-memory-index"
export type { SemanticIndex } from "./port"
export type { Document, EmbeddingVector, SearchError, SearchHit } from "./types"
