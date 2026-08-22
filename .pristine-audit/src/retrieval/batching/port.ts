/**
 * Closed port for the embed-batcher (ADR-0264).
 *
 * The batcher accepts a single `text` per call and resolves with the
 * embedding vector or a typed {@link BatchError}. Coalesces with any
 * other in-window calls and any in-flight identical text (single-flight).
 *
 * A {@link flush} hook exists for test determinism — production drives
 * the timer, tests call `flush()` to drain synchronously.
 */
import type { Result } from "@/shared"
import type { BatchError, EmbeddingVector } from "./types"

export interface EmbedBatcher {
  /** Submit one text. Result resolves with the vector or a typed error. */
  embed(text: string, opts?: { signal?: AbortSignal }): Promise<Result<EmbeddingVector, BatchError>>

  /** Trigger an immediate flush of any pending texts. Idempotent. */
  flush(): Promise<void>

  /** Number of texts currently queued (not yet flushed). Observability. */
  pending(): number
}
