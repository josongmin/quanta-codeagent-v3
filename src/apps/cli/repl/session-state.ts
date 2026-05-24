import type { ImageBlock, LLMPort, Message } from "@/llm"

/** Slice-C: the 5 god-state `let`s that `runRepl` carried inline (`cwd`,
 *  `llm`, `sessionId`, `pendingImages`, `history`) collapsed into ONE record
 *  + an immutable {@link updateSessionState} helper.
 *
 *  The record is the surface-scoped state that flows turn-to-turn:
 *
 *    - `cwd`           — current working directory (may chdir on id-mode resume)
 *    - `llm`           — composed LLM stack (Retrying ➜ fallback ➜ auto)
 *    - `sessionId`     — id-mode session id (mints on `--new-session`, swaps on resume)
 *    - `pendingImages` — `--image` seed attachments; drained after the FIRST turn
 *    - `history`       — full transcript so far (Messages); rebound after each runOnce
 *
 *  Held as a `let` binding by `runRepl` so each turn ⇒ `state = updateSessionState(...)`
 *  rather than 5 scattered `let` reassignments. */
export interface SessionState {
  readonly cwd: string
  readonly llm: LLMPort
  readonly sessionId: string | undefined
  readonly pendingImages: readonly ImageBlock[]
  readonly history: readonly Message[]
}

/** Immutable update: returns a NEW record with `patch` overlaid on `prev`.
 *  Fields not mentioned in `patch` carry through verbatim. Mirrors the
 *  Record / spread idiom — kept as a named helper so the call site reads as
 *  intent (`state = updateSessionState(state, { history: result.messages })`)
 *  rather than spread noise. */
export const updateSessionState = (
  prev: SessionState,
  patch: Partial<SessionState>,
): SessionState => ({ ...prev, ...patch })
