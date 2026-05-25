/**
 * `@/retrieval/reranker` types — ADR-0262.
 *
 * Distinct from `src/retrieval/types.ts`'s `RerankPort` family — those four
 * built-in strategies (identity / bm25-secondary / tier-aware / RRF) are PURE
 * and throw on programmer-bug. This module covers VENDOR rerankers (Cohere
 * rerank-v3.5 / Voyage rerank-2) where call failure is an EXPECTED domain
 * event surfaced via `Result<…, RerankError>`. Both ports coexist; mixing
 * them is a non-goal (see the ADR's "Why a NEW port" table).
 *
 * Element type is GENERIC — the caller pairs hits with a `documentOf` mapper
 * that extracts the text the vendor scores. This keeps the port reusable
 * across `RetrievalCandidate`, `MemoryHit`, file-search rows, etc.
 */

/**
 * A reranked hit — preserves the index in the INPUT `hits` array so the
 * caller can correlate back without an extra lookup. `score` is the
 * vendor's relevance score (higher = more relevant). For the identity
 * pass-through the score is `1`.
 */
export interface RerankedHit<T = unknown> {
  readonly originalIndex: number
  readonly score: number
  readonly hit: T
}

/**
 * Provider-declared capability envelope. All four fields are REQUIRED —
 * leaving any of them optional would leak `undefined` under
 * `exactOptionalPropertyTypes: true`, defeating the introspection contract
 * (callers branch on these values to decide whether to chunk, batch, or
 * bypass the port).
 */
export interface RerankerCapabilities {
  readonly provider: "identity" | "cohere" | "voyage" | "headless"
  readonly model: string
  /** Hard cap per single `rerank()` call. Caller must chunk above this. */
  readonly maxDocsPerCall: number
  /** Hard cap on total input tokens (query + docs) per call. */
  readonly maxInputTokens: number
}

/**
 * Closed 5-arm error union. Every consumer's `switch (e.kind)` is
 * exhaustive (compile-fail when a new arm is added).
 */
export type RerankError =
  | { readonly kind: "auth-failed" }
  | { readonly kind: "rate-limited" }
  | { readonly kind: "empty-query" }
  | { readonly kind: "too-many-docs"; readonly limit: number; readonly given: number }
  | { readonly kind: "transport"; readonly message: string }
