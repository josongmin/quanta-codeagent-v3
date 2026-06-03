/**
 * Bounded NDJSON ring buffer — pure backpressure policy (ADR-0468).
 *
 * A live introspection firehose can outrun its consumer (the monitor is busy,
 * the socket is slow). An unbounded queue would be a memory leak; a synchronous
 * blocking write would stall the agent loop. The mature middle ground is a
 * bounded ring buffer with an explicit, caller-chosen loss model:
 *
 *   - `"drop-oldest"`   — evict the oldest line to admit the newest (favor
 *     recency; the dropped count is exposed so the loss is observable).
 *   - `"reject-newest"` — refuse the newest line and report `buffer-full`
 *     (favor the buffered tail; caller decides to retry/await/drop). This is
 *     the pure realization of the spec's "block" — a pure structure cannot
 *     suspend, so it back-signals instead of blocking the caller's thread.
 *
 * `capacity` is a REQUIRED, validated config field — NOT a magic constant. A
 * non-positive or non-integer capacity is a construction `Err`, never a silent
 * clamp (clamping hides operator mistakes).
 *
 * Pure: no IO, no clock, no randomness. Fully deterministic — the hellgate
 * pins exact eviction/rejection behavior at the boundary.
 *
 * Plane-clean: imports ONLY `@/shared`.
 */

import { err, ok, type Result } from "@/shared"
import type { BackpressurePolicy, NdjsonConfigError, RingBufferConfig } from "./types"

/** Result of offering one line to the buffer. `dropped` is the number of lines
 *  evicted to admit this one (0 or 1 for a single offer under drop-oldest; 0
 *  otherwise). `accepted=false` means a `reject-newest` buffer was full. */
export interface OfferOutcome {
  readonly accepted: boolean
  readonly dropped: number
}

/** Bounded FIFO ring buffer with a caller-chosen overflow policy. */
export interface NdjsonRingBuffer {
  /** Offer one already-encoded line. Never throws. */
  offer(line: string): OfferOutcome
  /** Drain every buffered line in FIFO order, emptying the buffer. */
  drain(): string[]
  /** Number of lines currently buffered. */
  size(): number
  /** Configured capacity (echoed for assertions / introspection). */
  readonly capacity: number
  /** The active overflow policy. */
  readonly policy: BackpressurePolicy
  /** Cumulative count of lines dropped due to overflow over the buffer's
   *  lifetime (drop-oldest only; reject-newest never drops — it rejects). */
  totalDropped(): number
}

/** Construct a bounded ring buffer. Validates `capacity` strictly so an
 *  operator typo (0, -1, 3.5, NaN) is a loud `Err` rather than a buffer that
 *  silently drops everything or never bounds. */
export const createNdjsonRingBuffer = (
  config: RingBufferConfig,
): Result<NdjsonRingBuffer, NdjsonConfigError> => {
  const { capacity, policy } = config
  if (!Number.isInteger(capacity) || capacity <= 0) {
    return err({
      kind: "invalid-config",
      reason: `capacity must be a positive integer, got ${String(capacity)}`,
    })
  }
  if (policy !== "drop-oldest" && policy !== "reject-newest") {
    return err({
      kind: "invalid-config",
      reason: `unknown backpressure policy: ${String(policy)}`,
    })
  }

  // Simple array-backed FIFO. capacity is small (operator-stated, e.g. a few
  // thousand lines) so shift() on drop-oldest is fine; correctness over
  // micro-optimization. A true circular array would complicate drain ordering
  // for zero observable gain at these scales.
  const lines: string[] = []
  let dropped = 0

  return ok({
    capacity,
    policy,
    offer(line: string): OfferOutcome {
      if (lines.length < capacity) {
        lines.push(line)
        return { accepted: true, dropped: 0 }
      }
      // Buffer full.
      if (policy === "drop-oldest") {
        lines.shift() // evict oldest
        lines.push(line)
        dropped += 1
        return { accepted: true, dropped: 1 }
      }
      // reject-newest: keep the tail, refuse the newcomer.
      return { accepted: false, dropped: 0 }
    },
    drain(): string[] {
      // Splice out everything in FIFO order, leaving the buffer empty.
      return lines.splice(0, lines.length)
    },
    size(): number {
      return lines.length
    },
    totalDropped(): number {
      return dropped
    },
  })
}
