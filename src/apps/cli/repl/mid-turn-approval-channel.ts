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
 * Pure + closed-port: this module holds NO stdin; the session loop feeds it lines
 * and the approval prompt awaits them. Fully unit-testable.
 */

export interface MidTurnApprovalChannel {
  /** True while an in-turn reader owns stdin (set by the session loop around each
   *  turn). The approval prompt consults this to decide: await a routed line
   *  (true) vs open its own readline (false). */
  active: boolean
  /** Approval prompt: render done by the caller; await the operator's next line.
   *  Resolves with the routed line, or "" if the turn ends first (⇒ caller treats
   *  a non-"y" as deny — fail-closed, never a silent allow). */
  awaitLine(): Promise<string>
  /** Session loop `onLine`: deliver a captured line to a waiting approval. Returns
   *  true iff it was consumed (so the caller skips the normal follow-up routing). */
  tryResolve(line: string): boolean
  /** Session loop turn teardown: release any waiter with "" (⇒ deny) so a turn
   *  that ends with an unanswered approval can never hang. */
  clear(): void
}

export const createMidTurnApprovalChannel = (): MidTurnApprovalChannel => {
  let pending: ((line: string) => void) | undefined
  return {
    active: false,
    awaitLine(): Promise<string> {
      // A prior unfinished waiter would be a wiring bug (one approval at a time);
      // release it as a deny before replacing, so it can't leak.
      if (pending !== undefined) {
        const stale = pending
        pending = undefined
        stale("")
      }
      return new Promise<string>((resolve) => {
        pending = resolve
      })
    },
    tryResolve(line: string): boolean {
      if (pending === undefined) return false
      const resolve = pending
      pending = undefined
      resolve(line)
      return true
    },
    clear(): void {
      if (pending !== undefined) {
        const resolve = pending
        pending = undefined
        resolve("")
      }
    },
  }
}
