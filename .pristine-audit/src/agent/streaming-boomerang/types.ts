/**
 * Streaming boomerang types (ADR-0251).
 *
 * Closed 3-arm chunk union the consumer iterates. The shape mirrors the
 * Roo Boomerang/Orchestrator wire format absorbed from
 * `.extracted_source/roo-cline/**`, narrowed to the minimum we need:
 *
 *   - `progress` — incremental text the parent surface renders.
 *   - `result`   — final success carrier; the iterator terminates after
 *                  emitting at most one of these (or one `error`).
 *   - `error`    — terminal failure with a closed errorKind union.
 *
 * Sibling of ADR-0218 (`BoomerangResult` — single typed result). This file
 * does NOT import from `@/agent/subagent-typed`; the result chunk's
 * `value` field is intentionally typed as a free-form readonly record so
 * the streaming slice can be wired to any producer (typed or not).
 *
 * exactOptionalPropertyTypes: absent fields are OMITTED, never
 * `undefined`-set.
 */

/** Closed 6-arm union — every operational failure surface the streaming
 *  layer can produce. The closed shape lets the host branch
 *  deterministically; no prose parsing.
 *
 *  Mirrors {@link BoomerangErrorKind} from ADR-0218 plus one streaming-
 *  specific arm:
 *    - `invalid-spec` — the spec the producer received was malformed at
 *      runtime (empty prompt, etc). Surfaces as the FIRST chunk (no
 *      progress chunks before it).
 */
export type BoomerangChunkErrorKind =
  | "cancelled"
  | "budget-overflow"
  | "mode-missing"
  | "runner-error"
  | "timeout"
  | "invalid-spec"

/** Closed 3-arm BoomerangChunk union. Discriminator: `kind`. */
export type BoomerangChunk = BoomerangProgressChunk | BoomerangResultChunk | BoomerangErrorChunk

/** Incremental progress payload. `text` is the raw chunk the producer
 *  emitted — utf-8 string, no trimming, no normalization (the consumer
 *  is the one that knows what to render). May be empty string (some
 *  producers emit empty heartbeats); the consumer chooses to render or
 *  drop. */
export interface BoomerangProgressChunk {
  readonly kind: "progress"
  readonly text: string
}

/** Terminal success chunk. `value` is a free-form readonly record the
 *  host agreed on with the producer (e.g. `{ summary, turns, tokens,
 *  artifacts }` — mirrors {@link BoomerangResult} from ADR-0218 but is
 *  not coupled to it). The iterator finishes after this chunk. */
export interface BoomerangResultChunk {
  readonly kind: "result"
  readonly value: Readonly<Record<string, unknown>>
}

/** Terminal failure chunk. `errorMessage` is free-form prose; the host
 *  branches on `errorKind`, not on the message. The iterator finishes
 *  after this chunk. */
export interface BoomerangErrorChunk {
  readonly kind: "error"
  readonly errorKind: BoomerangChunkErrorKind
  readonly errorMessage: string
}

/** Read-only list — handy for iteration + exhaustiveness in tests. */
export const BOOMERANG_CHUNK_KINDS: readonly BoomerangChunk["kind"][] = Object.freeze([
  "progress",
  "result",
  "error",
])

/** Read-only list of all 6 errorKind arms — used by the exhaustiveness
 *  test (HELL-SB-10) to detect drift if a new arm is added without
 *  the corresponding consumer branch. */
export const BOOMERANG_ERROR_KINDS: readonly BoomerangChunkErrorKind[] = Object.freeze([
  "cancelled",
  "budget-overflow",
  "mode-missing",
  "runner-error",
  "timeout",
  "invalid-spec",
])

/** Programmer-bug surface — thrown by the slice ONLY for invalid-by-
 *  construction input that bypasses the type system (e.g. a forced cast
 *  passes a non-string prompt). Operational invalid-spec (empty prompt,
 *  etc) is surfaced as an `error` chunk, NOT a throw. */
export class StreamingBoomerangError extends Error {
  override readonly name = "StreamingBoomerangError"
  readonly kind: "invalid-spec-runtime" | "producer-broken"
  constructor(kind: "invalid-spec-runtime" | "producer-broken", message: string) {
    super(message)
    this.kind = kind
  }
}

/** Closed shape of a chunk-producer's emit handle, handed by the
 *  streamer factory to the producer's body. The producer pushes chunks
 *  to the consumer via these handles; backpressure is implicit in the
 *  promise returned by `enqueue`.
 *
 *  `enqueue(progressOrResult)` — push a non-error chunk. Resolves when
 *  the consumer has consumed it (or the iterator is cancelled).
 *  `fail(errorKind, msg)` — emit a terminal error chunk; the iterator
 *  finishes after the consumer reads it.
 *  `done(value)` — emit a terminal result chunk; the iterator finishes
 *  after the consumer reads it.
 *
 *  The producer MUST NOT call any handle after `done` / `fail` resolves;
 *  doing so is a programmer bug and is rejected (no-op + warning in
 *  tests via assertion). */
export interface ChunkProducerHandle {
  enqueue(chunk: BoomerangProgressChunk): Promise<void>
  fail(errorKind: BoomerangChunkErrorKind, message: string): Promise<void>
  done(value: Readonly<Record<string, unknown>>): Promise<void>
  /** Observable on the consumer's cancellation (break / return / abort). */
  readonly cancelled: AbortSignal
}
