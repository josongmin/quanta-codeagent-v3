/**
 * `@/retrieval/engines` barrel — ADR-0261.
 *
 * Pluggable Embedder + VectorStore registries. Sibling of ADR-0254 single
 * in-memory cosine store / single OpenAI-style embedder. No call site
 * auto-consumes anything from this module — default-OFF.
 */

// Capabilities negotiator.
export type { MismatchError, NegotiatedCaps } from "./capabilities"
export { negotiateCapabilities } from "./capabilities"
// Embedder adapters.
export type { CohereEmbedderOptions, FetchFn as CohereFetchFn } from "./embedder/cohere-embedder"
export { createCohereEmbedder } from "./embedder/cohere-embedder"
export type { HeadlessStubOptions } from "./embedder/headless-stub"
export { createHeadlessEmbedder } from "./embedder/headless-stub"
export type { OllamaEmbedderOptions } from "./embedder/ollama-embedder"
export { createOllamaEmbedder } from "./embedder/ollama-embedder"
export type { OpenAIEmbedderOptions } from "./embedder/openai-embedder"
export { createOpenAIEmbedder } from "./embedder/openai-embedder"
// Embedder port + types.
export type { Embedder } from "./embedder/port"
// Embedder registry.
export type { EmbedderEnv, EmbedProvider } from "./embedder/registry"
export {
  createEmbedderFromEnv,
  EMBED_PROVIDERS,
  isEmbedProvider,
} from "./embedder/registry"
export type { EmbeddingSpace } from "./embedder/space"
export {
  embeddingSpaceFingerprint,
  embeddingSpaceFromCaps,
  embeddingSpaceKey,
  embeddingSpaceNamespace,
  embeddingSpacesEqual,
  HASH_EMBEDDING_SPACE,
} from "./embedder/space"
export type {
  EmbedderCapabilities,
  EmbedError,
  EmbedResult,
} from "./embedder/types"
export { EMBED_ERROR_KINDS } from "./embedder/types"
export type { VoyageEmbedderOptions } from "./embedder/voyage-embedder"
export { createVoyageEmbedder } from "./embedder/voyage-embedder"
// VectorStore adapters.
export type { InMemoryStoreOptions } from "./store/in-memory-store"
export { createInMemoryVectorStore } from "./store/in-memory-store"
export type { LanceStoreOptions } from "./store/lance-store"
export { createLanceVectorStore } from "./store/lance-store"
// VectorStore port + types.
export type { VectorStore } from "./store/port"
export type { QdrantStoreOptions } from "./store/qdrant-store"
export { createQdrantVectorStore } from "./store/qdrant-store"
// VectorStore registry.
export type { VectorStoreDeps, VectorStoreEnv, VectorStoreProvider } from "./store/registry"
export {
  createStoreFromEnv,
  isVectorStoreProvider,
  VECTOR_STORES,
} from "./store/registry"
export type { SqliteDb, SqliteVssStoreOptions } from "./store/sqlite-vss-store"
export { createSqliteVssStore } from "./store/sqlite-vss-store"
export type {
  Filter,
  StoreCapabilities,
  StoredDoc,
  StoredHit,
  StoreError,
} from "./store/types"
export { STORE_ERROR_KINDS } from "./store/types"
