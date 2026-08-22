/**
 * UUX-1-15 — spinner-stall detector → operator-notice bus wire.
 *
 * # Why
 *
 * The ADR-0227 detector ticks in adapters (`StreamInput.onChunk`) but had NO
 * surface sink: a provider stream going silent mid-turn was invisible to the
 * operator (the exact "why is it stuck?" class the agent-state north star
 * targets). The operator-notice bus (WS-G, `@/shared/operator-notice`) is the
 * ONE seam for surfacing such degrade signals; this module is the bridge.
 *
 * # Where the wire lives (and where it does NOT)
 *
 * Co-located with the detector slice so the COMPOSITION ROOT that constructs a
 * detector wires the notice path in ONE call:
 *
 *   const detector = createDefaultStallDetector()
 *   const emitter  = wireStallDetectorToOperatorNotices(detector)
 *   // thread detector.tickEvent into StreamInput.onChunk; poll(emitter) on a cadence
 *
 * NOT inside adapters — adapters only honor the best-effort tick hook
 * (ADR-0234) and stay sink-free. As of jul-10 no live composition constructs a
 * detector yet (the CLI turn-indicator composition is the natural owner); this
 * wire is the ready-made seam for that root.
 *
 * # Latch / no-spam contract (pinned by
 * `tests/unit/llm/spinner-stall-operator-notice-hellgate.test.ts`)
 *
 * The latch rides the emitter's per-episode edge-triggering
 * (`createSpinnerStallEmitter`): `spinner-stalled` fires ONCE per stall
 * episode (repeat polls while still stalled re-emit NOTHING), and a recovery
 * (`tickEvent` arrival or explicit `stop`/`forceClear`) clears the latch — the
 * detector DOES distinguish recovery, so the clear also surfaces one low-key
 * `info` notice and re-arms the warn for a future episode.
 *
 * # Default posture
 *
 * Headless / bench / any surface that never installs an operator-notice sink:
 * `emitOperatorNotice` is a total no-op by bus contract, and a hostile sink
 * can never poison the poll (the bus swallows). Byte-identical when unwired.
 */

import { emitOperatorNotice } from "@/shared"
import {
  createSpinnerStallEmitter,
  type SpinnerStallEmitter,
  type SpinnerStallSink,
} from "./event-emitter"
import type { SpinnerStallDetectorPort } from "./port"

/** Origin tag rendered before the message (bus convention, cf. `"/replay"`,
 *  `"mcp"`). */
const NOTICE_SOURCE = "llm-stream"

/** A {@link SpinnerStallSink} that renders stall edges as operator notices.
 *  Pure mapping — the per-episode latch (edge-triggering) is owned by the
 *  emitter that feeds it. */
export const createOperatorNoticeStallSink = (
  emit: typeof emitOperatorNotice = emitOperatorNotice,
): SpinnerStallSink => ({
  emit(event): void {
    if (event.kind === "spinner-stalled") {
      emit({
        severity: "warn",
        source: NOTICE_SOURCE,
        message: `model stream stalled — no data for ${Math.round(event.stalledForMs / 1000)}s (${event.correlationId})`,
        hint: "still waiting on the provider; the hard idle timeout will abort if it never resumes",
      })
      return
    }
    // spinner-stall-cleared — the clear edge: close the loop for the operator
    // (one per episode, so bounded by the same latch as the warn). Worded as
    // "cleared", NOT "resumed": the emitter fires the SAME event for a live
    // recovery (tick arrived) and for an explicit stop/forceClear (turn ended),
    // and this sink cannot distinguish them — claiming "resumed" on a stop
    // would be a false signal.
    emit({
      severity: "info",
      source: NOTICE_SOURCE,
      message: `model stream stall cleared (${event.correlationId})`,
    })
  },
})

/** ONE-call wiring for the composition root that constructs a detector:
 *  returns the edge-triggered emitter whose `poll(now)` surfaces stall/recover
 *  edges as latched operator notices. See the module doc for the contract. */
export const wireStallDetectorToOperatorNotices = (
  detector: SpinnerStallDetectorPort,
): SpinnerStallEmitter => createSpinnerStallEmitter(detector, createOperatorNoticeStallSink())
