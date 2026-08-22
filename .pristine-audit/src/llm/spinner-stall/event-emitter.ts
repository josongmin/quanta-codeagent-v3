/**
 * ADR-0227 — Spinner stall event emitter (port + default impl).
 *
 * # What this is
 *
 * A thin reactor on top of {@link SpinnerStallDetectorPort} that converts
 * the pull-based `checkAll` API into push-based `spinner-stalled` /
 * `spinner-stall-cleared` notifications on an injected sink. Separating
 * the *detection* from the *emission* keeps the detector pure (no IO, no
 * sink reference) and lets the surface decide what "emit" means (CLI
 * panel, OTel attr, structured log, …).
 *
 * # The two event kinds
 *
 *  - `spinner-stalled` — fired the FIRST poll on which a correlation is
 *    stalled. Subsequent polls while still stalled do NOT re-emit (per-id
 *    edge-triggered, not level-triggered).
 *  - `spinner-stall-cleared` — fired when a previously-stalled correlation
 *    either ticks again (live recovery) or is `stop`ped (turn ended).
 *
 * Edge-triggering matters: a level-triggered design would spam the UI
 * every poll-interval. Claude Code's telemetry pair
 * (`tengu_spinner_stalled_ui` / `tengu_spinner_stall_cleared`) is also
 * edge-triggered for the same reason.
 *
 * # Closed port + DI
 *
 * The sink is a port (`SpinnerStallSink`). The CLI surface wires a real
 * sink that paints a "still working… [r]etry / [a]bort" panel; tests wire
 * an array push to assert event sequences; production callers without a
 * surface (e.g. headless bench) wire no sink at all and use the detector
 * directly. Default-OFF: no sink, no emitter, no behaviour change.
 *
 * # Plane-clean
 *
 * Imports only the sibling port file and types. No `@/agent`, no
 * `@/observability`. The emitter's lifecycle (when to poll, when to
 * shut down) is owned by whoever constructs it.
 */

import type { SpinnerStallDetectorPort, StallEvent } from "./port"

/** Discriminated event union dispatched to the {@link SpinnerStallSink}. */
export type SpinnerStallEvent =
  | {
      readonly kind: "spinner-stalled"
      readonly correlationId: string
      readonly stalledForMs: number
    }
  | {
      readonly kind: "spinner-stall-cleared"
      readonly correlationId: string
    }

/** Where the emitter dispatches events. The CLI surface implements this
 *  with a panel-paint routine; tests implement it with an array push. */
export interface SpinnerStallSink {
  emit(event: SpinnerStallEvent): void
}

/** Internal book-keeping: which correlation ids the emitter currently
 *  considers "stalled" (i.e. it already fired `spinner-stalled` for them
 *  and has not yet fired `spinner-stall-cleared`). */
const stalledSetKey = Symbol("stalledSet")

/** A poll-driven reactor. Call {@link SpinnerStallEmitter.poll} at the
 *  caller's chosen cadence (typically every 1s by a timer in the agent
 *  loop or CLI surface). The emitter dedupes against its own internal
 *  "currently stalled" set to deliver edge-triggered notifications. */
export interface SpinnerStallEmitter {
  /** Run a single detection round. Reads stalls from the detector,
   *  diffs against the previously-stalled set, and emits the edge
   *  transitions. */
  poll(now: number): void
  /** Force-clear a correlation id from the emitter's stalled set,
   *  emitting `spinner-stall-cleared` IF it was previously stalled.
   *  Called from the stream-timeout hook so that when a stream is
   *  `stop`ped (turn ended) the surface gets a clean clear, even if
   *  the next `poll` never runs. */
  forceClear(correlationId: string): void
}

/** Construct an emitter wired to a detector + sink.
 *
 *  Default-OFF: if neither this factory is called nor a poll happens,
 *  the detector is unaffected — the detector is pure book-keeping and
 *  the emitter is the only thing that turns its state into events.
 *
 *  ## Edge-triggering algorithm
 *
 *  Each `poll(now)`:
 *    1. Detector.checkAll(now) → currently-stalled set S_now.
 *    2. For id ∈ S_now \ S_prev: emit `spinner-stalled`.
 *    3. For id ∈ S_prev \ S_now: emit `spinner-stall-cleared` (this is
 *       the live-recovery path: a tick arrived and pushed lastEventMs
 *       past the threshold boundary, so the detector dropped it).
 *    4. S_prev := S_now.
 *
 *  Cleared events from `stop` flow through `forceClear` (the detector
 *  removes the entry, so it never appears in checkAll, so step 3 above
 *  would catch it — but only on the NEXT poll. `forceClear` shortens
 *  that latency to "immediately" for the explicit-stop case).
 */
export const createSpinnerStallEmitter = (
  detector: SpinnerStallDetectorPort,
  sink: SpinnerStallSink,
): SpinnerStallEmitter => {
  // Use a Set keyed on correlationId. The symbol marker is purely for
  // debuggability — if someone logs the emitter they see the dedicated
  // field rather than an opaque generic Set.
  const stalled: Set<string> & { [stalledSetKey]?: true } = new Set()
  stalled[stalledSetKey] = true

  const emitStalled = (event: StallEvent): void => {
    sink.emit({
      kind: "spinner-stalled",
      correlationId: event.correlationId,
      stalledForMs: event.stalledForMs,
    })
  }
  const emitCleared = (correlationId: string): void => {
    sink.emit({ kind: "spinner-stall-cleared", correlationId })
  }

  return {
    poll(now: number): void {
      const fresh = detector.checkAll({ now })
      const freshIds = new Set<string>()
      for (const event of fresh) {
        freshIds.add(event.correlationId)
        if (!stalled.has(event.correlationId)) {
          // New stall edge.
          stalled.add(event.correlationId)
          emitStalled(event)
        }
      }
      // Cleared edges: ids we previously thought were stalled but the
      // detector no longer reports. Iterate a snapshot so deletes are
      // safe.
      for (const previousId of [...stalled]) {
        if (!freshIds.has(previousId)) {
          stalled.delete(previousId)
          emitCleared(previousId)
        }
      }
    },

    forceClear(correlationId: string): void {
      // Only emit if we were currently tracking it as stalled —
      // otherwise this is a no-op (matches the "tickEvent on unknown id
      // is silent" symmetry).
      if (stalled.delete(correlationId)) {
        emitCleared(correlationId)
      }
    },
  }
}
