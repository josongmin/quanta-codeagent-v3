/**
 * Closeout guard (SOTA++ CloseoutLens — Codex App agent loop doc §4 mirror).
 * Pure, deterministic policy: no LLM, no I/O. Addresses an observed gap —
 * v3 has NO finish-time self-check, so the agent can produce overclaims at
 * the moment of completion ("verified" when no verification ran, fact mixed
 * with inference, ignoring requested reporting shape).
 *
 * Mechanism mirrors verify-guard (one-shot nudge via the existing recovery
 * machinery) but at a DIFFERENT trigger point (finish-intent, content-agnostic)
 * and with DIFFERENT content (the closeout reminder). Intentionally simpler
 * than verify-guard: no history inspection (works on finish-intent + state
 * alone), no `maxTrips` knob — closeout is single-shot by design (multiple
 * closeout nudges would just thrash; one nudge is the entire value), no
 * tool-name semantics. Absent config ⇒ guard fully OFF (byte-identical loop).
 */

/** Per-session closeout budget. One instance per agent run. Single-shot cap
 *  is enforced by the policy (`trips >= 1` ⇒ no block), not by a knob. */
export interface CloseoutGuardState {
  trips: number
}

/** Fresh state for a session — zero closeout nudges spent. */
export const createCloseoutGuardState = (): CloseoutGuardState => ({ trips: 0 })

/** The closeout nudge injected just before a finish attempt. Single-line
 *  forcing message naming the four CloseoutLens directives: keep only defended
 *  claims, state explicitly if verification was not run, separate fact from
 *  inference, match the requested reporting shape. */
export const CLOSEOUT_REMINDER =
  "Before finishing: keep only defended claims, state explicitly if verification was not run, separate fact from inference, and match the requested reporting shape. Then stop only if those hold."

/**
 * Decide whether to block a finish attempt and inject the closeout reminder.
 * Pure: the only side effect is incrementing `state.trips` when it blocks
 * (the loop owns the state object). Logic:
 *   - `cfg === undefined`        ⇒ guard OFF, byte-identical.
 *   - `cfg.enabled !== true`     ⇒ off unless explicitly enabled.
 *   - `state.trips >= 1`         ⇒ already tripped this run (single-shot cap).
 *   - otherwise                  ⇒ trip once and return the reminder.
 */
export const decideCloseoutGuard = (args: {
  state: CloseoutGuardState
  cfg: { enabled?: boolean } | undefined
}): { block: boolean; text?: string } => {
  const { cfg, state } = args
  if (cfg === undefined) return { block: false }
  if (cfg.enabled !== true) return { block: false }
  if (state.trips >= 1) return { block: false }
  state.trips += 1
  return { block: true, text: CLOSEOUT_REMINDER }
}
