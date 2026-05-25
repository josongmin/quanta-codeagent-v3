/**
 * Focus Chain drift detector (ADR-0219).
 *
 * "Drift" = the model is in a long-running turn loop but the todo list
 * shows zero progress. Cline's heuristic: 5 turns of no `markDone` / no
 * `setTodos` is the operational signal that the model has gotten distracted.
 *
 * We expose a pure predicate so the tracker can ask "is this drift?" with
 * a single integer comparison. The injected `windowTurns` is the threshold
 * — caller's choice, default 5 (the Cline operational value).
 *
 * The returned warning string is a ONE-LINER suitable for splicing into a
 * `<system-reminder>` block. It's intentionally short so it doesn't bloat
 * the next turn's tokens; the model is expected to read it and re-orient.
 */

export interface DriftState {
  /** The current turn count (monotonic, set by the tracker). */
  readonly currentTurn: number
  /** The turn at which the most recent todo state change happened. */
  readonly lastActivityTurn: number
  /** The drift window — N turns of no activity ⇒ drift. */
  readonly windowTurns: number
}

/** True iff (current - lastActivity) >= windowTurns AND windowTurns > 0.
 *  Guards: negative windows / non-finite numbers ⇒ false (no drift). */
export const isDrifting = (s: DriftState): boolean => {
  if (!Number.isFinite(s.windowTurns) || s.windowTurns <= 0) return false
  if (!Number.isFinite(s.currentTurn) || s.currentTurn < 0) return false
  if (!Number.isFinite(s.lastActivityTurn) || s.lastActivityTurn < 0) return false
  return s.currentTurn - s.lastActivityTurn >= s.windowTurns
}

/** Build the one-line drift warning. Returns `null` when not drifting. */
export const formatDriftWarning = (s: DriftState): string | null => {
  if (!isDrifting(s)) return null
  const elapsed = s.currentTurn - s.lastActivityTurn
  return (
    `Focus Chain drift detected: ${elapsed} turns with no todo progress. ` +
    `Re-read your todo list above; mark items done or replan.`
  )
}
