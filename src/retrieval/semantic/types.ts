/**
 * Semantic-search slice — public types (ADR-0254).
 *
 * Closed shapes for the {@link Document} corpus, the {@link SearchHit}
 * result, the {@link EmbeddingVector} carrier, and the {@link SearchError}
 * closed discriminated union. Kept in one file so every adapter in the
 * slice reaches a SINGLE source of truth — no back-edges from the index
 * adapter to the headless embedder or vice versa.
 *
 * The slice imports `@/shared` (Result/ok/err) only. No other slice
 * appears as a dependency.
 */

/** A unit of indexable text + caller-side metadata. */
export interface Document {
  readonly id: string
  readonly text: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** A retrieved document plus its cosine similarity score against the query. */
export interface SearchHit {
  readonly id: string
  /** Cosine similarity in [-1, 1]. NaN never crosses the boundary. */
  readonly score: number
  readonly text: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

/**
 * An embedding vector. Readonly so callers cannot mutate the index's
 * backing store after `index()` returns.
 */
export type EmbeddingVector = readonly number[]

/**
 * Closed discriminated union of every failure mode the index / embedder
 * can surface across the port boundary. Adding a new kind here is the OCP
 * signal — every consumer narrows by `kind` and gets an exhaustive-check
 * fail at compile time.
 */
export type SearchError =
  | { kind: "empty-text" }
  | { kind: "invalid-k"; k: number }
  | { kind: "embed-failed"; cause: unknown }
  | { kind: "dim-mismatch"; expected: number; actual: number }
