/**
 * `Embedder` — closed port for any provider that turns text into a vector
 * (ADR-0254).
 *
 * Deliberately separate from `SemanticIndex` (it is INJECTED at index
 * construction time, not a field on the index). This split keeps the I/O
 * boundary (HTTP to OpenAI / local model) cleanly distinct from the pure
 * math of cosine similarity — tests can swap a deterministic stub without
 * touching the index implementation, and a production wiring round can
 * substitute a real embedder one file at a time.
 */

import type { Result } from "@/shared"
import type { EmbeddingVector } from "./types"

/**
 * Closed error union for embedder failure modes. Mirrors the relevant
 * cases of {@link SearchError} but lives separately so the embedder
 * surface stays minimal — the index decides how (or whether) to map
 * `EmbedError` onto `SearchError` (the in-memory adapter forwards both
 * variants verbatim).
 */
export type EmbedError = { kind: "empty-text" } | { kind: "embed-failed"; cause: unknown }

export interface Embedder {
  /**
   * Embed a single text. Returns `Result` so the I/O failure path crosses
   * the port boundary as data, not as an exception.
   */
  embed(text: string): Promise<Result<EmbeddingVector, EmbedError>>
  /**
   * Fixed output dimension. The index validates every returned vector
   * against this value at index / query time — a vendor that ignores
   * `dim()` and returns a different length surfaces as
   * `{ kind: "dim-mismatch" }` at the index boundary.
   */
  dim(): number
}
