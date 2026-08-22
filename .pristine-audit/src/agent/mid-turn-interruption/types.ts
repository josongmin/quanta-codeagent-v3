/**
 * Mid-turn user interruption — TYPES (ADR-0177).
 *
 * Captures user input that arrives WHILE a turn is in flight and decides
 * whether to (a) queue the input for the next turn boundary (Codex /
 * ChatGPT-web pattern), (b) cancel the current stream so the new input
 * REPLACES the in-flight prompt (Cursor Cmd-K pattern), or (c) cancel +
 * AMEND the prior user turn with the new text appended (rare; useful when
 * the user realised they forgot a constraint right after pressing enter).
 *
 * The CAPTURE FACADE wires over `PlanQueueStore` (ADR-0128 — already shipped)
 * and returns an `InterruptionDecision` so the caller (CLI input loop)
 * knows whether to fire a cancel-channel signal. The PlanQueue stores the
 * text regardless (so even cancel-mode follow-ups are replayed once the
 * stream actually drains).
 *
 * Plane-clean: imports nothing from `@/agent/loop`, `@/llm`, `@/tool`. Pure
 * types — the consumer (CLI) holds the cancel channel.
 *
 * Voice-match: ADR-0128 (PlanQueueStore — 12-field FollowUp + per-thread
 * LRU); ADR-0177-sibling `streaming-cancellation/types.ts` for the
 * `CancellationCause` value space (currently in-flight on another worktree
 * — we mirror the `"user-abort"` literal which both ADRs will land with).
 */

/** How the caller wants this mid-turn input handled. CLOSED enum so the
 *  policy has a finite decision space and the test matrix is exhaustive. */
export type InterruptionMode =
  | "queue" // hold input; inject at next turn boundary (typing-while-streaming)
  | "cancel-and-replace" // abort current stream; new input becomes next user turn (Cursor Cmd-K)
  | "cancel-and-amend" // abort current stream; append new input to prior user turn (rare)

/** Cancellation cause for the streaming-cancellation channel. Mirrors the
 *  `CancellationCause` literal from the sibling slice — defining it here
 *  too (rather than importing) keeps this module plane-clean and lets the
 *  two slices ship in either order. The sibling will export the SAME
 *  string union; consumers can structurally assign across. */
export type MidTurnCancelCause = "user-abort"

export interface MidTurnInput {
  readonly text: string
  readonly receivedAtMs: number
  readonly mode: InterruptionMode
  /** Hint of where we were when input arrived. Carried into
   *  `FollowUp.arrivedDuringTurn` for replay ordering. */
  readonly observedTurnIndex: number
  /** When `mode` is one of the cancel-* variants, the cause to surface
   *  via the cancellation channel. OMITTED (never `undefined`) when
   *  `mode === "queue"`. Defaults to `"user-abort"` if the caller picks
   *  a cancel mode without specifying. */
  readonly cancelCause?: MidTurnCancelCause
}

export interface InterruptionDecision {
  readonly action: "queue" | "cancel"
  readonly reason: string
}

export interface InterruptionPolicy {
  /** Decide what to do with this input given the current turn state.
   *  MUST be synchronous + total — the capture facade traps thrown
   *  errors and substitutes a synthetic decision (NO-THROW invariant). */
  decide(
    input: MidTurnInput,
    ctx: { readonly turnIndex: number; readonly stillStreaming: boolean },
  ): InterruptionDecision
}

export interface MidTurnCapture {
  /** Called by the CLI input loop when the user submits while a turn is
   *  in flight. Returns the decision so the caller knows whether to fire
   *  cancel + stash input or just stash. Always resolves — internal
   *  errors collapse into a synthetic `{action:"queue", reason:...}`. */
  capture(input: MidTurnInput): Promise<InterruptionDecision>
  /** Drain all queued inputs for the next turn. Mirrors plan-queue
   *  `drain` semantics: entries removed from the live window, ordered
   *  urgent-first then enqueued-ascending. */
  drainForTurn(turnIndex: number): Promise<ReadonlyArray<MidTurnInput>>
  /** Inspect pending queue without draining. Returns a fresh array each
   *  call — mutating it does not affect the underlying store. */
  peek(): ReadonlyArray<MidTurnInput>
}
