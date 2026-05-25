/**
 * Default {@link ProposeHandlerPort} (ADR-0223).
 *
 * Wraps a {@link StuckDetectorPort} probe with the once-per-id rule. State
 * is a single `Map<toolCallId, "proposed" | "accepted" | "dismissed">` —
 * three terminal states + the absent (= "not yet proposed") implicit fourth.
 * `shouldPropose` flips absent → "proposed" exactly once and returns true
 * exactly once per id; every subsequent call returns false regardless of
 * what `isStuck` says.
 *
 * Plane-clean: imports ONLY `./port` from the slice. NO dispatch / loop /
 * stream — the host wires the prompt UI; this slice DECIDES when to surface.
 *
 * NO-THROW: every method is total. A garbage id is a no-op write/read; a
 * detector that throws is wrapped in a try/catch (defense-in-depth — the
 * port contract says detectors don't throw, but a future host-built detector
 * could regress; we keep the proposer's no-throw promise structurally).
 */

import type { ProposeHandlerPort, StuckDetectorPort } from "./port"

/** Construction-time options for {@link defaultProposeHandler}. */
export interface DefaultProposeHandlerOpts {
  /** The detector this proposer consults. The same detector instance MUST
   *  be wired to the dispatch wrapper (so `tickToolStart`/`tickToolEnd`
   *  populate the store this proposer reads). Tests inject fakes. */
  readonly detector: StuckDetectorPort
}

/** Internal state tag — three terminal states (proposed/accepted/dismissed)
 *  + the absent fourth (= "not yet proposed"). Once an id transitions out of
 *  absent, `shouldPropose` will never return true again for that id. */
type ProposalState = "proposed" | "accepted" | "dismissed"

export const defaultProposeHandler = (opts: DefaultProposeHandlerOpts): ProposeHandlerPort => {
  const detector = opts.detector
  // Insertion-order Map — `hasProposed` checks `state !== undefined` so
  // tombstones don't leak across `dismiss`. Capacity is bounded by the
  // detector's running set + accepted/dismissed terminals; in practice a
  // long session ends thousands of tool calls so this map grows. Pruning is
  // the host's responsibility (a future ADR may wire prune to `tickToolEnd`
  // — kept out of this slice to preserve the once-per-id invariant in the
  // face of a tool that ends and restarts with the same id).
  const state = new Map<string, ProposalState>()

  /** Safe-probe helper: a detector that throws (out-of-contract) cannot
   *  break the proposer's no-throw promise. We treat any throw as
   *  "not stuck" — conservative posture (no spurious proposals). */
  const probeStuck = (toolCallId: string, now: number): boolean => {
    try {
      return detector.isStuck({ toolCallId, now }).stuck
    } catch {
      return false
    }
  }

  return {
    shouldPropose(input) {
      // Already in a terminal state ⇒ never propose again. Bypass `isStuck`
      // entirely (zero-work on the hot poll path).
      if (state.has(input.toolCallId)) return false
      if (!probeStuck(input.toolCallId, input.now)) return false
      // Transition absent → "proposed" atomically. From this point on,
      // every subsequent `shouldPropose` for this id returns false until
      // the host's `accept` / `dismiss` further constrains the state (or
      // it stays "proposed" forever — both are absorbing states for the
      // shouldPropose surface).
      state.set(input.toolCallId, "proposed")
      return true
    },

    accept(input) {
      // Always set — idempotent. From "proposed" → "accepted"; from absent
      // → "accepted" (a host that accepted without first asking; this is a
      // host bug but we don't validate — the once-per-id rule still holds
      // because the id is now in a terminal state).
      state.set(input.toolCallId, "accepted")
    },

    dismiss(input) {
      // Dismiss is the SECOND important transition (the user said no). From
      // this point the id is permanently dampened — even if `isStuck` keeps
      // returning true on every poll, no re-propose. Contract §5.
      state.set(input.toolCallId, "dismissed")
    },

    hasProposed(toolCallId) {
      // Any of the three terminal states counts as "ever proposed" — the
      // diagnostic question is "did the surface flash for this id?". A host
      // that calls `accept` without first asking still counts (see comment
      // in `accept` above).
      return state.has(toolCallId)
    },
  }
}
