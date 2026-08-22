/**
 * `@/retrieval/reranker` barrel — ADR-0262.
 *
 * Vendor-aware reranker port + 4 adapters (identity / cohere / voyage /
 * headless) + env-driven factory. Coexists with the slice-internal
 * `RerankPort` family in `src/retrieval/rerank/` (4 pure strategies).
 */

export type {
  CohereHttp,
  CohereRerankerOptions,
  CohereRerankRequest,
  CohereRerankResponse,
  CohereRerankResult,
} from "./cohere-reranker"
export { createCohereReranker, defaultCohereHttp } from "./cohere-reranker"
export type { HeadlessRerankerOptions } from "./headless-stub"
export { headlessReranker } from "./headless-stub"
export { identityReranker } from "./identity-reranker"
export type { Reranker } from "./port"
export type { RerankerFromEnvOptions } from "./registry"
export { createRerankerFromEnv } from "./registry"
export type { RerankError, RerankedHit, RerankerCapabilities } from "./types"
export type {
  VoyageHttp,
  VoyageRerankerOptions,
  VoyageRerankRequest,
  VoyageRerankResponse,
  VoyageRerankResult,
} from "./voyage-reranker"
export { createVoyageReranker, defaultVoyageHttp } from "./voyage-reranker"
