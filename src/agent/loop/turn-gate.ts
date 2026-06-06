/**
 * Per-turn subagent gate view + abort classification (ADR-0437).
 *
 * SRP: interrupt vs lifetime-cancel routing only. No stream/tool side effects.
 */

import type { SubagentTurnGate } from "@/subagent"
import type { TurnSession } from "../turn-context"
import type { TurnResult } from "./types"

/**
 * Build the per-turn session view used for interrupt.
 *
 * Absent gate ⇒ returns the SAME session by identity (byte-identical default-OFF).
 */
export const buildTurnSessionView = (
  session: TurnSession,
): {
  readonly turnSession: TurnSession
  readonly gate: SubagentTurnGate | undefined
} => {
  const gate = session.config.subagentTurnGate
  if (gate === undefined) return { turnSession: session, gate: undefined }
  const config = { ...session.config, signal: gate.armTurn(session.config.signal) }
  return { turnSession: { ...session, config }, gate }
}

/**
 * Classify a turn-body abort.
 *
 * INTERRUPT (`{kind:"interrupted"}`) ONLY when the gate's per-turn controller
 * fired AND the lifetime signal did NOT; otherwise lifetime cancel (`aborted`).
 */
export const classifyTurnAbort = (
  gate: SubagentTurnGate | undefined,
  loopSignal: AbortSignal,
): TurnResult =>
  gate?.wasInterrupted() === true && !loopSignal.aborted
    ? { kind: "interrupted" }
    : { kind: "aborted" }
