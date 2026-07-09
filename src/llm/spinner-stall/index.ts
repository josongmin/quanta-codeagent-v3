/**
 * ADR-0227 — Spinner stall detection slice barrel.
 *
 * Absorbs Claude Code's `tengu_spinner_stalled_ui` / `tengu_spinner_stall_cleared`
 * telemetry pair as a closed-port primitive. The detector is pure
 * book-keeping; the emitter is the edge-triggered reactor; the sink is
 * a surface-side DI seam.
 *
 * Default-OFF: nothing in the loop wires this on by default. Callers
 * that want the "still working… [r]etry / [a]bort" UX construct a
 * detector + sink + emitter and poll the emitter on their own cadence.
 *
 * Knob: `spinnerStall.thresholdMs` (default {@link DEFAULT_SPINNER_STALL_THRESHOLD_MS}).
 */

export { createDefaultStallDetector, type DefaultStallDetectorOpts } from "./default-detector"
export {
  createSpinnerStallEmitter,
  type SpinnerStallEmitter,
  type SpinnerStallEvent,
  type SpinnerStallSink,
} from "./event-emitter"
// UUX-1-15 — detector → operator-notice bus bridge (latched warn per stall
// episode; recovery clears the latch + surfaces one info). The composition
// root that constructs a detector wires the notice path with ONE call.
export {
  createOperatorNoticeStallSink,
  wireStallDetectorToOperatorNotices,
} from "./operator-notice-wire"
export type {
  CheckAllArgs,
  SpinnerStallDetectorPort,
  StallEvent,
  StartArgs,
  StopArgs,
  TickEventArgs,
} from "./port"

/** Default threshold matching Claude Code's `tengu_spinner_stalled_ui`
 *  fire-time (~30s). Override via the `spinnerStall.thresholdMs` knob
 *  passed to `start`. */
export const DEFAULT_SPINNER_STALL_THRESHOLD_MS = 30_000
