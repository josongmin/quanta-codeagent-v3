/**
 * Mid-turn approval input channel (jun-10 fix) — the CONFLICT resolver between
 * the in-turn keystroke reader and a mid-turn approval prompt.
 *
 * BUG it fixes: while a turn streams, `in-turn-reader.ts` holds `process.stdin`
 * (raw mode + a `data` accumulator) to capture queued follow-ups. When a tool
 * needs approval MID-TURN, the old approval prompt opened a SECOND ad-hoc
 * `readline` on the same stdin — the two readers fought, `question()` got no
 * usable line, and the approval fail-closed to DENY ("입력창이 안 떠서"). The
 * symptom the operator saw: "Approval required …" printed, then "runtime session
 * approval denied" with no chance to answer.
 *
 * FIX: ONE reader. The in-turn reader already captures every completed line; when
 * an approval is pending, its next line is ROUTED here (resolving the prompt)
 * instead of being queued as a follow-up. No second stdin consumer, no raw-mode
 * fight. Between turns (no in-turn reader) the prompt falls back to its own
 * readline — `active` stays false there.
 *
 * WS-A (jul-10, UUX-1-22/UUX-3-11) — TYPED release. The old `clear()` resolved
 * a pending waiter with the bare string `""`, indistinguishable from the
 * operator pressing Enter on an empty line: turn cancel / Ctrl+B backgrounding /
 * teardown all silently became "operator denied". A release is now a
 * DISCRIMINATED value carrying its cause, so the prompt can attribute the
 * outcome honestly (fail-closed deny + a visible notice, never a silent one).
 *
 * Pure + closed-port: this module holds NO stdin; the session loop feeds it lines
 * and the approval prompt awaits them. Fully unit-testable.
 */

/** Why a pending waiter was released without operator input. */
export type MidTurnReleaseCause =
  /** The turn ended (completed / canceled / backgrounded) with the ask unanswered. */
  | "turn_teardown"
  /** A second `awaitLine` superseded a stale waiter (one-ask-at-a-time wiring bug). */
  | "superseded"

/** What `awaitLine` resolves to: a REAL operator line (possibly empty — an empty
 *  Enter is still input) vs a typed RELEASE (never disguised as input). */
export type MidTurnLineResult =
  | { readonly kind: "line"; readonly line: string }
  | { readonly kind: "released"; readonly cause: MidTurnReleaseCause }

export interface MidTurnApprovalChannel {
  /** True while an in-turn reader owns stdin (set by the session loop around each
   *  turn). The approval prompt consults this to decide: await a routed line
   *  (true) vs open its own readline (false). */
  active: boolean
  /** Approval prompt: render done by the caller; await the operator's next line.
   *  Resolves `{kind:"line"}` with the routed input, or `{kind:"released"}` when
   *  the turn ends first — the caller maps a release to a fail-closed deny AND
   *  surfaces the cause (never a silent deny). */
  awaitLine(): Promise<MidTurnLineResult>
  /** Session loop `onLine`: deliver a captured line to a waiting approval. Returns
   *  true iff it was consumed (so the caller skips the normal follow-up routing). */
  tryResolve(line: string): boolean
  /** Session loop turn teardown: release any waiter with the given cause so a
   *  turn that ends with an unanswered approval can never hang — and the prompt
   *  can attribute WHY it was released (typed, never a fake empty line). */
  clear(cause: MidTurnReleaseCause): void
}

export const createMidTurnApprovalChannel = (): MidTurnApprovalChannel => {
  let pending: ((result: MidTurnLineResult) => void) | undefined
  const release = (cause: MidTurnReleaseCause): void => {
    if (pending === undefined) return
    const resolve = pending
    pending = undefined
    resolve({ kind: "released", cause })
  }
  return {
    active: false,
    awaitLine(): Promise<MidTurnLineResult> {
      // A prior unfinished waiter would be a wiring bug (one approval at a time);
      // release it TYPED before replacing, so it can't leak or fake a deny.
      release("superseded")
      return new Promise<MidTurnLineResult>((resolve) => {
        pending = resolve
      })
    },
    tryResolve(line: string): boolean {
      if (pending === undefined) return false
      const resolve = pending
      pending = undefined
      resolve({ kind: "line", line })
      return true
    },
    clear(cause: MidTurnReleaseCause): void {
      release(cause)
    },
  }
}
