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
 * C2 (jul-10 audit) — FIFO ASK QUEUE, replacing the supersede semantics. The
 * old one-ask-at-a-time rule (a second `awaitLine` released the first as a
 * fail-closed `superseded` deny) was a SINGLE-consumer wiring invariant: with
 * only the approval prompt awaiting, a second concurrent ask could only be a
 * bug. The WS-B registry made the channel MULTI-consumer — approval prompts
 * AND the MCP elicitation / ask_user prompter share it — so two legitimate
 * concurrent asks (an approval pending while an elicitation arrives) had the
 * first DESTROYED: the operator lost an ask they never got to answer. Queueing
 * is the correct semantics: `awaitLine` ENQUEUES, `tryResolve` feeds the HEAD
 * waiter only, and each settled head promotes the next. Prompt RENDERING moves
 * with it: ask sites hand their render to the `onActive` hook, which the
 * channel fires when the waiter BECOMES head (first-in-queue: synchronously,
 * so the single-ask render timing is byte-identical to the render-then-await
 * code it replaces) — a queued second prompt can never print over an
 * unanswered first one. `clear(cause)` flushes EVERY queued waiter typed; a
 * consumer's AbortSignal splices ONLY its own waiter (head or mid-queue).
 *
 * Pure + closed-port: this module holds NO stdin; the session loop feeds it lines
 * and the approval prompt awaits them. Fully unit-testable.
 */

/** Why a pending waiter was released without operator input. */
export type MidTurnReleaseCause =
  /** The turn ended (completed / canceled / backgrounded) with the ask unanswered. */
  | "turn_teardown"
  /** Audit W3-C1 — the CONSUMER's own AbortSignal fired mid-await (e.g. an
   *  MCP-side elicitation cancel). The channel releases THAT waiter so the
   *  operator's next line is never claimed by a dead ask. */
  | "consumer_aborted"

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
  /** Approval prompt / elicitation: ENQUEUE an ask and await the operator's
   *  line routed to it in FIFO order. Resolves `{kind:"line"}` with the routed
   *  input, or `{kind:"released"}` when the turn ends first — the caller maps a
   *  release to a fail-closed deny AND surfaces the cause (never a silent
   *  deny). An optional `signal` releases THIS waiter (`consumer_aborted`) when
   *  the consumer cancels mid-await — spliced from the queue wherever it sits,
   *  never touching the others (audit W3-C1). `label` names the ask for
   *  diagnostics. C2 — `onActive` is the ask's PROMPT RENDER hook: the channel
   *  calls it when this waiter becomes the queue head (synchronously inside
   *  `awaitLine` when the queue was empty — byte-identical single-ask render
   *  timing). Rendering at enqueue would print a second prompt over an
   *  unanswered first one; consumers must render HERE, not before the call. */
  awaitLine(signal?: AbortSignal, label?: string, onActive?: () => void): Promise<MidTurnLineResult>
  /** Session loop `onLine`: deliver a captured line to the HEAD waiter. Returns
   *  true iff it was consumed (so the caller skips the normal follow-up
   *  routing). Settling the head promotes — and renders — the next waiter. */
  tryResolve(line: string): boolean
  /** Session loop turn teardown: release EVERY queued waiter with the given
   *  cause so a turn that ends with unanswered asks can never hang any of them
   *  — and each prompt can attribute WHY it was released (typed, never a fake
   *  empty line). */
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

interface Waiter {
  /** Diagnostic name of the ask (e.g. "approval" / "elicitation"). */
  readonly label: string | undefined
  /** C2 — the ask's prompt render hook; fired exactly once, at head activation. */
  readonly onActive: (() => void) | undefined
  /** Settle + abort-listener cleanup. Queue membership is the pending marker:
   *  a waiter is settled iff it has been removed from the queue. */
  readonly settle: (result: MidTurnLineResult) => void
  activated: boolean
}

export const createMidTurnApprovalChannel = (): MidTurnApprovalChannel => {
  const queue: Waiter[] = []

  /** Fire the head's render hook if it has not run yet. Called from inside
   *  `tryResolve` / abort handling (the session loop's line-routing stack), so
   *  a THROWING hook is fenced: it must never break line routing — but a
   *  swallowed throw would leave an INVISIBLE prompt pending forever, so the
   *  waiter whose render failed is released typed (its consumer's hook is its
   *  own failure) and the next one is promoted. */
  const activateHead = (): void => {
    const head = queue[0]
    if (head === undefined || head.activated) return
    head.activated = true
    try {
      head.onActive?.()
    } catch {
      queue.shift()
      head.settle({ kind: "released", cause: "consumer_aborted" })
      activateHead()
    }
  }

  return {
    active: false,
    awaitLine(
      signal?: AbortSignal,
      label?: string,
      onActive?: () => void,
    ): Promise<MidTurnLineResult> {
      if (signal?.aborted === true) {
        return Promise.resolve({ kind: "released", cause: "consumer_aborted" })
      }
      let waiter: Waiter | undefined
      const promise = new Promise<MidTurnLineResult>((resolve) => {
        const settle = (result: MidTurnLineResult): void => {
          signal?.removeEventListener("abort", onAbort)
          resolve(result)
        }
        const onAbort = (): void => {
          // Splice ONLY our own waiter — head or mid-queue. Already settled
          // (not in the queue) ⇒ a stale abort, which must touch nothing.
          const idx = waiter === undefined ? -1 : queue.indexOf(waiter)
          if (idx === -1 || waiter === undefined) return
          const wasHead = idx === 0
          queue.splice(idx, 1)
          waiter.settle({ kind: "released", cause: "consumer_aborted" })
          if (wasHead) activateHead() // the next ask renders + takes the line source
        }
        waiter = { label, onActive, settle, activated: false }
        signal?.addEventListener("abort", onAbort, { once: true })
        queue.push(waiter)
      })
      // C2 — first-in-queue activates SYNCHRONOUSLY: for the single-ask case
      // the prompt renders at the exact point the pre-queue code rendered it
      // (before the await), byte-identical timing. A synchronous render throw
      // propagates to the caller like the old render-then-await did — the
      // waiter is spliced first so it can never leak as an invisible head.
      if (waiter !== undefined && queue[0] === waiter) {
        waiter.activated = true
        try {
          waiter.onActive?.()
        } catch (err) {
          queue.splice(queue.indexOf(waiter), 1)
          throw err
        }
      }
      return promise
    },
    tryResolve(line: string): boolean {
      const head = queue.shift()
      if (head === undefined) return false
      head.settle({ kind: "line", line })
      // Promote synchronously: the next ask's prompt is on screen before any
      // further captured line could be routed at it.
      activateHead()
      return true
    },
    clear(cause: MidTurnReleaseCause): void {
      // Flush EVERYONE typed — including queued waiters whose prompt never
      // rendered (their consumers still surface the release honestly).
      const flushed = queue.splice(0, queue.length)
      for (const w of flushed) w.settle({ kind: "released", cause })
    },
  }
}
