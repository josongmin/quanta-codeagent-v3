/**
 * ADR-0227 — Default {@link SpinnerStallDetectorPort} implementation.
 *
 * Backed by a `Map<correlationId, Entry>`. All methods are O(1) except
 * `checkAll` which is O(n) over registered ids — n is bounded by the
 * number of concurrent LLM streams (~1 for a single agent, ~K for K
 * parallel sub-agents). At realistic K this is negligible.
 *
 * Plane-clean: imports the port only. Clock is injected via a closure
 * captured from the constructor (no global Date.now).
 */

import type {
  CheckAllArgs,
  SpinnerStallDetectorPort,
  StallEvent,
  StartArgs,
  StopArgs,
  TickEventArgs,
} from "./port"

/** Per-correlation tracking record. */
interface Entry {
  /** Wall-clock ms of the most recent `tickEvent` (or `start` if none). */
  lastEventMs: number
  /** Threshold this correlation is registered with (frozen at `start`
   *  time; re-`start` overwrites). */
  thresholdMs: number
}

/** Options for {@link createDefaultStallDetector}. */
export interface DefaultStallDetectorOpts {
  /** Test seam: a monotonic-ish clock returning ms. Defaults to
   *  `Date.now`. The detector NEVER calls this internally — it only
   *  threads through caller-provided `now`s — but constructors may want
   *  to capture a reference for future expansion (kept for symmetry with
   *  the rest of the codebase's ClockPort pattern). Today it is unused
   *  by the impl itself, which is why ALL public methods take `now` as
   *  an arg rather than reading it internally. */
  readonly now?: () => number
}

export const createDefaultStallDetector = (
  _opts?: DefaultStallDetectorOpts,
): SpinnerStallDetectorPort => {
  // Insertion-order Map → `checkAll` returns stalls in the order they were
  // first registered, which is the most useful order for a UI surface that
  // wants to focus on the "primary" turn.
  const entries = new Map<string, Entry>()

  return {
    start(args: StartArgs): void {
      // Idempotent: re-`start` resets the last-event marker AND lets a
      // mid-stream knob change take effect on the next poll.
      entries.set(args.correlationId, {
        lastEventMs: args.now,
        thresholdMs: args.stallThresholdMs,
      })
    },

    tickEvent(args: TickEventArgs): void {
      const entry = entries.get(args.correlationId)
      // Unknown id ⇒ no-op (contract §2). The stream-timeout hook calls
      // this on EVERY chunk regardless of whether anyone registered the
      // correlation; we MUST be silent in that case.
      if (entry === undefined) return
      entry.lastEventMs = args.now
    },

    stop(args: StopArgs): void {
      // Idempotent: Map.delete on an absent key returns false silently.
      // Removing the entry guarantees no memory leak across turns.
      entries.delete(args.correlationId)
    },

    checkAll(args: CheckAllArgs): readonly StallEvent[] {
      const stalls: StallEvent[] = []
      for (const [correlationId, entry] of entries) {
        const elapsed = args.now - entry.lastEventMs
        // Strict `>`: a stream that ticked exactly at `now - threshold` is
        // NOT yet stalled (matches HELL-SPS-02). The Claude Code
        // implementation uses the same boundary so the UX of "stalls
        // exactly at 30s" is a single-frame transition.
        if (elapsed > entry.thresholdMs) {
          stalls.push({ correlationId, stalledForMs: elapsed })
        }
      }
      return stalls
    },
  }
}
