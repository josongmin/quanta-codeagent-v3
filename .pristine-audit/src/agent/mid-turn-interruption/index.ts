/**
 * Mid-turn user interruption — public barrel (ADR-0177).
 */

export {
  alwaysCancelPolicy,
  alwaysQueuePolicy,
  defaultInterruptionPolicy,
  defaultMidTurnCapture,
  type MidTurnCaptureOpts,
} from "./default"
export type {
  InterruptionDecision,
  InterruptionMode,
  InterruptionPolicy,
  MidTurnCancelCause,
  MidTurnCapture,
  MidTurnInput,
} from "./types"
