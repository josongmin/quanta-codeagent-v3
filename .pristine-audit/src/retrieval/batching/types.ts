/**
 * Public types for the embed-batcher slice (ADR-0264).
 *
 * - {@link EmbeddingVector} is an alias of `readonly number[]` so the batcher
 *   wraps any of Axis D's 8 vendor adapters without a converter.
 * - {@link BatchConfig} is the caller-supplied tuning surface — no default.
 * - {@link BatchError} is a closed 4-arm discriminated union; the hellgate
 *   proves exhaustiveness via `assertNever`.
 */

export type EmbeddingVector = readonly number[]

export interface BatchConfig {
  /** Accumulation window in ms. `0` schedules on `queueMicrotask`. */
  readonly windowMs: number
  /** Provider per-request batch_size cap. Outgoing chunks honour this. */
  readonly maxBatchSize: number
}

export type BatchError =
  | { kind: "underlying-failed"; detail: string }
  | { kind: "aborted" }
  | { kind: "vector-missing"; text: string }
  | { kind: "config-invalid"; detail: string }
