/**
 * B5 (jul-03) — presence-aware push DECISION. Pure predicate; the ONLY place
 * that encodes the precedence of "should we actually write the OSC/BEL push?".
 *
 * Absorbed from Claude Code's presence-gated push: when the user is actively at
 * the keyboard we suppress the terminal push (the notification is for when they
 * have LOOKED AWAY). quanta's SSOT presence signal is the existing
 * {@link IdleMonitor}: `present === !idle.isIdle()`. No new focus tracker, no new
 * threshold — presence reuses the existing `QUANTA_IDLE_MS` window.
 *
 * Precedence (highest first) — a single disabledReason is reported so accounting
 * never double-counts one suppressed push:
 *   1. `config_off`   — the feature is not opted in (channel === "off").
 *   2. `no_transport` — there is no write sink / TTY to push to.
 *   3. `user_present` — the user is present (recent activity) ⇒ hold the push.
 * Only when NONE hold do we push.
 *
 * Pure: no env / clock / I/O. The adapter injects the resolved booleans.
 */

/** Why a push was NOT sent. Exactly one is reported (highest-precedence). */
export type PushDisabledReason = "config_off" | "user_present" | "no_transport"

export interface PushDecisionInput {
  /** `"on"` iff the notify feature is opted in (channel !== "off"). */
  readonly status: "on" | "off"
  /** True iff the user is present (`!idle.isIdle()` at the wire point). */
  readonly present: boolean
  /** True iff a write sink / TTY exists to receive the push. */
  readonly transport: boolean
}

export interface PushDecision {
  /** True iff the push should actually be written. */
  readonly pushSent: boolean
  /** Set iff `pushSent === false` — the single highest-precedence reason. */
  readonly disabledReason?: PushDisabledReason
}

/**
 * Decide whether a terminal push should be written. Pure. See the module
 * docstring for the precedence rationale.
 */
export const shouldPush = (input: PushDecisionInput): PushDecision => {
  if (input.status === "off") return { pushSent: false, disabledReason: "config_off" }
  if (!input.transport) return { pushSent: false, disabledReason: "no_transport" }
  if (input.present) return { pushSent: false, disabledReason: "user_present" }
  return { pushSent: true }
}
