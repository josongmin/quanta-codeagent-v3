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
  /** Audit W3-C1 — the CONSUMER's own AbortSignal fired mid-await (e.g. an
   *  MCP-side elicitation cancel). The channel releases THAT waiter so the
   *  operator's next line is never claimed by a dead ask. */
  | "consumer_aborted"

/** What `awaitLine` resolves to: a REAL operator line (possibly empty — an empty
 *  Enter is still input) vs a typed RELEASE (never disguised as input).
 *
 *  C2 (jul-10 W4) — the channel is shared by approval prompts AND elicitation
 *  (registry slot), so a `superseded` release additionally names the LABEL of
 *  the ask that superseded this waiter (when the superseder declared one). The
 *  collision stays fail-closed — this only makes it diagnosable at the consumer
 *  ("approval prompt superseded by elicitation ask", not a mystery deny). */
export type MidTurnLineResult =
  | { readonly kind: "line"; readonly line: string }
  | {
      readonly kind: "released"
      readonly cause: MidTurnReleaseCause
      /** Only on `cause: "superseded"`, and only when the superseding
       *  `awaitLine` passed a label. NEVER set on teardown/abort releases. */
      readonly supersededBy?: string
    }

export interface MidTurnApprovalChannel {
  /** True while an in-turn reader owns stdin (set by the session loop around each
   *  turn). The approval prompt consults this to decide: await a routed line
   *  (true) vs open its own readline (false). */
  active: boolean
  /** Approval prompt: render done by the caller; await the operator's next line.
   *  Resolves `{kind:"line"}` with the routed input, or `{kind:"released"}` when
   *  the turn ends first — the caller maps a release to a fail-closed deny AND
   *  surfaces the cause (never a silent deny). An optional `signal` releases
   *  THIS waiter (`consumer_aborted`) when the consumer cancels mid-await, so a
   *  dead ask can never claim the operator's next line (audit W3-C1).
   *  C2 (jul-10 W4) — an optional `label` names THIS ask (e.g. "approval",
   *  "elicitation"); when it supersedes a stale waiter, that waiter's release
   *  carries `supersededBy: label` so the collision is diagnosable. */
  awaitLine(signal?: AbortSignal, label?: string): Promise<MidTurnLineResult>
  /** Session loop `onLine`: deliver a captured line to a waiting approval. Returns
   *  true iff it was consumed (so the caller skips the normal follow-up routing). */
  tryResolve(line: string): boolean
  /** Session loop turn teardown: release any waiter with the given cause so a
   *  turn that ends with an unanswered approval can never hang — and the prompt
   *  can attribute WHY it was released (typed, never a fake empty line). */
  clear(cause: MidTurnReleaseCause): void
}

/** WS-B (jul-10, UUX-1-05) — the process-wide CURRENT channel slot. The CLI
 *  session composition registers its per-session channel here so surfaces
 *  composed at a DIFFERENT layer (the MCP elicitation prompter / ask_user io,
 *  built at LLM-wiring time before the session channel exists) can route their
 *  mid-turn reads through the SAME single line source instead of opening a
 *  second readline that fights the in-turn reader. One live REPL session per
 *  process — a re-register (REPL restart) simply replaces the slot. */
let currentChannel: MidTurnApprovalChannel | undefined

export const registerMidTurnApprovalChannel = (channel: MidTurnApprovalChannel): void => {
  currentChannel = channel
}

/** The registered channel, or undefined outside a composed session. Callers
 *  MUST consult `.active` before awaiting (inactive ⇒ use their own readline —
 *  between turns stdin has no in-turn owner). */
export const currentMidTurnApprovalChannel = (): MidTurnApprovalChannel | undefined =>
  currentChannel

export const createMidTurnApprovalChannel = (): MidTurnApprovalChannel => {
  let pending: ((result: MidTurnLineResult) => void) | undefined
  const release = (cause: MidTurnReleaseCause, supersededBy?: string): void => {
    if (pending === undefined) return
    const resolve = pending
    pending = undefined
    // C2 — only a supersede names its superseder; the key is OMITTED otherwise
    // so teardown/abort release shapes stay byte-identical to the WS-A landing.
    resolve({ kind: "released", cause, ...(supersededBy !== undefined ? { supersededBy } : {}) })
  }
  return {
    active: false,
    awaitLine(signal?: AbortSignal, label?: string): Promise<MidTurnLineResult> {
      // A prior unfinished waiter would be a wiring bug (one approval at a time);
      // release it TYPED before replacing, so it can't leak or fake a deny —
      // and NAME the superseding ask (C2) so the collision is diagnosable.
      release("superseded", label)
      if (signal?.aborted === true) {
        return Promise.resolve({ kind: "released", cause: "consumer_aborted" })
      }
      return new Promise<MidTurnLineResult>((resolve) => {
        const entry = (result: MidTurnLineResult): void => {
          signal?.removeEventListener("abort", onAbort)
          resolve(result)
        }
        const onAbort = (): void => {
          // Release only OUR waiter — a superseding consumer's waiter is a
          // different closure, so a stale abort can never clobber it.
          if (pending === entry) {
            pending = undefined
            entry({ kind: "released", cause: "consumer_aborted" })
          }
        }
        signal?.addEventListener("abort", onAbort, { once: true })
        pending = entry
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
