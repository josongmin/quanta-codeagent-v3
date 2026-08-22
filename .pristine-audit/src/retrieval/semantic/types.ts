/**
 * Semantic-search slice — public types (ADR-0254).
 *
 * After the dead text-in `SemanticIndex` port + in-memory cosine adapter
 * were removed (proven-duplicate of the live vector-in `SemanticIndex` in
 * `@/retrieval/pipeline`), the only surviving carrier is
 * {@link EmbeddingVector} — consumed by the `Embedder` port and the
 * deterministic headless embedder.
 *
 * The slice imports `@/shared` (Result/ok/err) only. No other slice
 * appears as a dependency.
 */

/**
 * An embedding vector. Readonly so callers cannot mutate the embedder's
 * output after `embed()` returns.
 */
export type EmbeddingVector = readonly number[]
