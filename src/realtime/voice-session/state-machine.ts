/**
 * Realtime voice-session — pure state-machine reducer (ADR-0439, RFC §3.2).
 *
 * `(state, action) → state`. No I/O, no time, no randomness — fully unit
 * testable in isolation (HELL-RTV-02). The `default-session` drives real I/O
 * THROUGH this reducer so transitions are single-sourced.
 *
 * Legal transitions:
 *
 *   idle ──start──► connecting ──opened──► listening ◄────────────┐
 *    ▲                  │                     │                    │
 *    │close-from-idle   │connect-failed       │turn-start          │turn-done / interrupt
 *    │                  ▼                     ▼                    │
 *    └──────────────── idle               responding ─────────────┘
 *
 *   {connecting,listening,responding} ──close / remote-closed──► closed
 *
 * Any action illegal for the current state returns `{ state, ok:false }` so
 * the caller surfaces a typed `illegal-state` Err. Plane-clean: zero imports.
 */

import type { VoiceSessionState } from "./port"

/** Reducer actions. Mirror the session lifecycle + inbound events. */
export type VoiceSessionAction =
  /** start() invoked from idle. */
  | { readonly type: "start" }
  /** transport opened + session.update acked ⇒ listening. */
  | { readonly type: "opened" }
  /** connect/auth/mic failure during connecting ⇒ back to idle. */
  | { readonly type: "connect-failed" }
  /** model began responding (response.created / first delta). */
  | { readonly type: "turn-start" }
  /** response.done OR local interrupt ⇒ back to listening. */
  | { readonly type: "turn-done" }
  /** graceful close() OR remote/unrecoverable close. */
  | { readonly type: "close" }

/** Reducer result — the next state + whether the action was legal. Illegal
 *  actions leave the state unchanged and flag `ok:false`. */
export interface ReduceResult {
  readonly state: VoiceSessionState
  readonly ok: boolean
}

const legal = (state: VoiceSessionState): ReduceResult => ({ state, ok: true })
const illegal = (state: VoiceSessionState): ReduceResult => ({ state, ok: false })

/**
 * Pure transition. Closed over the action union — exhaustive.
 */
export const reduce = (state: VoiceSessionState, action: VoiceSessionAction): ReduceResult => {
  // `close` is legal from any non-closed state (idempotent at the closed sink).
  if (action.type === "close") {
    return state === "closed" ? legal("closed") : legal("closed")
  }

  switch (state) {
    case "idle":
      return action.type === "start" ? legal("connecting") : illegal(state)
    case "connecting":
      if (action.type === "opened") return legal("listening")
      if (action.type === "connect-failed") return legal("idle")
      return illegal(state)
    case "listening":
      return action.type === "turn-start" ? legal("responding") : illegal(state)
    case "responding":
      return action.type === "turn-done" ? legal("listening") : illegal(state)
    case "closed":
      // Terminal. No action other than close (handled above) is legal.
      return illegal(state)
    default: {
      // Exhaustiveness guard — compile error if a state is added without a case.
      const _never: never = state
      return illegal(_never)
    }
  }
}
