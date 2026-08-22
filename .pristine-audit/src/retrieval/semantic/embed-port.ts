/**
 * `Embedder` — closed port for any provider that turns text into a vector
 * (ADR-0254).
 *
 * A standalone I/O boundary (HTTP to OpenAI / local model) that any
 * consumer injects. Keeping it separate from vector-store / index concerns
 * lets tests swap a deterministic stub for the real provider, and a
 * production wiring round can substitute a real embedder one file at a
 * time.
 */

import type { Result } from "@/shared"
import type { EmbeddingVector } from "./types"

/**
 * Closed error union for embedder failure modes. Kept minimal — a consumer
 * decides how (or whether) to map `EmbedError` onto its own error surface.
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
