/**
 * `proposeOnIdleForLongTask` — sample radar heuristic (ADR-0231).
 *
 * If the operator has been idle for `> idleThresholdMs` AND the most
 * recent task took `> taskDurationThresholdMs` to complete, emit a
 * `"next-step"` proposal suggesting a follow-up review. Otherwise
 * return `null` (no proposal).
 *
 * **PURE** — no I/O, no clock, no store reference. The caller passes
 * the four inputs (typically read from session telemetry) and decides
 * what to do with the result: deposit it into a `RadarStore`, log it,
 * combine with other signals, etc.
 *
 * This is one example of the heuristic shape. Production grows the
 * catalog: stuck-loop detector, abandoned-todo finder, watcher-fired
 * suggestion, branch-drift warning, etc. Each new heuristic ships as
 * its own file in `src/radar/heuristics/` with the same
 * `(inputs) → ProposeOpts | null` shape.
 */

import type { ProposeOpts } from "../types"

export interface IdleLongTaskInputs {
  /** Milliseconds since the operator's last input. */
  readonly idleMs: number
  /** Wall-clock duration of the most recent task in milliseconds. */
  readonly lastTaskDurationMs: number
  /** If `idleMs` is at least this, the operator is considered idle. */
  readonly idleThresholdMs: number
  /** If `lastTaskDurationMs` is at least this, the task was long. */
  readonly taskDurationThresholdMs: number
  /** Wall-clock millis to stamp the proposal with. */
  readonly nowMs: number
  /** Optional session id to anchor the proposal to. */
  readonly sessionId?: string
}

export const proposeOnIdleForLongTask = (inputs: IdleLongTaskInputs): ProposeOpts | null => {
  if (inputs.idleMs < inputs.idleThresholdMs) return null
  if (inputs.lastTaskDurationMs < inputs.taskDurationThresholdMs) return null

  const base: {
    kind: "next-step"
    title: string
    description: string
    createdAtMs: number
    sessionId?: string
  } = {
    kind: "next-step",
    title: "Review the long task that just finished",
    description: `The last task ran for ${inputs.lastTaskDurationMs}ms and you have been idle for ${inputs.idleMs}ms — a quick review may surface follow-up actions worth queueing.`,
    createdAtMs: inputs.nowMs,
  }
  if (inputs.sessionId !== undefined) base.sessionId = inputs.sessionId
  return base
}
