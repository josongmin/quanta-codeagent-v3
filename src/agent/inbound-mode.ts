/**
 * Inbound message-delivery mode — the SSOT for how a user message fired WHILE a
 * turn is in flight is handled. Three modes:
 *
 *   - `queue`     — append to the follow-up queue; it runs as the NEXT turn once
 *                   the current one finishes (FIFO follow-up; the default).
 *   - `weave`     — inject the message into the CURRENT in-flight turn so the
 *                   model sees it on its next step (Claude-IDE live blend). Built
 *                   on the §steer decision engine (`steer()`).
 *   - `interrupt` — abort the current turn and resubmit this message as a fresh
 *                   turn (Codex barge-in / overwrite-and-restart).
 *
 * {@link routeInbound} is the PURE decision: given the mode + the live turn
 * snapshot, it returns WHAT the surface should do. It never performs the side
 * effect (the CLI/loop executes it) and never reaches mutable state — the clock
 * + turn snapshot are injected (deterministic / replay-safe).
 *
 * KEY INVARIANT — a message is NEVER silently lost. A `weave`/`interrupt` that
 * cannot apply (no active turn, a non-steerable review/compact turn, an
 * interrupted turn, a turn-id mismatch) falls back to `queue_fallback` carrying
 * the original text + the reason, so the surface still enqueues it (and can ack
 * the user why it degraded). Only genuinely empty / oversized input is
 * `rejected` (consistent across all three modes).
 */

import {
  type ActiveTurnState,
  type SteerConfig,
  type SteerInjection,
  type SteerRejectionReason,
  steer,
} from "./steering"

export type InboundMode = "queue" | "interrupt" | "weave"

/** Closed set — drift guard + CLI cycle iterate this. */
export const ALL_INBOUND_MODES = [
  "queue",
  "interrupt",
  "weave",
] as const satisfies readonly InboundMode[]

/** The non-default modes (need an active steerable turn to apply directly). */
type NonQueueMode = Exclude<InboundMode, "queue">

/** Discriminated decision the surface executes. */
export type InboundDecision =
  /** Enqueue → next turn (the default path; also the explicit `queue` mode). */
  | { readonly kind: "queue"; readonly text: string }
  /** Inject into the current turn (steer accepted). */
  | { readonly kind: "weave"; readonly injection: SteerInjection }
  /** Abort the current turn + resubmit `text` as a fresh turn. */
  | { readonly kind: "interrupt"; readonly text: string }
  /** A weave/interrupt that could not apply mid-turn — enqueued instead (NOT
   *  lost); `reason` is the steer rejection so the surface can ack the user. */
  | {
      readonly kind: "queue_fallback"
      readonly text: string
      readonly from: NonQueueMode
      readonly reason: SteerRejectionReason
    }
  /** Genuinely unusable input — nothing is enqueued. */
  | { readonly kind: "rejected"; readonly reason: "empty_input" | "input_too_large" }

export interface RouteInboundArgs {
  readonly mode: InboundMode
  readonly input: string
  /** Live turn snapshot (the loop's `activeTurnRef.current`). */
  readonly state: ActiveTurnState
  readonly config: SteerConfig
  /** Injected wall-clock ms (no `Date.now()` in core). */
  readonly now: number
  /** Optional optimistic-concurrency turn id the surface observed. Omitted ⇒
   *  target whatever turn is active (the CLI never observes a turn id). */
  readonly expectedTurnId?: string
}

/** Pure routing decision — see module header. */
export const routeInbound = (args: RouteInboundArgs): InboundDecision => {
  const { mode, input, state, config, now } = args

  // ONLY genuinely empty input is a hard reject (nothing to deliver). Oversized
  // input is NEVER dropped: `queue`/`interrupt` preserve it via the next-turn
  // path (no inject-size constraint there), and `weave`'s `steer()` downgrades
  // an over-`maxInputBytes` line to `queue_fallback` below — so a large paste is
  // always at least queued, never silently lost.
  if (input.trim().length === 0) return { kind: "rejected", reason: "empty_input" }

  if (mode === "queue") return { kind: "queue", text: input }

  if (mode === "weave") {
    // Reuse the §steer engine as the SINGLE source of steerability truth. Target
    // the active turn's id when the surface did not observe one.
    const expectedTurnId = args.expectedTurnId ?? state.currentTurn?.turnId
    if (expectedTurnId === undefined) {
      // No active turn ⇒ steer would reject `no_active_turn`; skip the call (it
      // requires a string turn id) and fall back to queue.
      return { kind: "queue_fallback", text: input, from: "weave", reason: "no_active_turn" }
    }
    const outcome = steer({ input, expectedTurnId, submittedAt: now }, state, config)
    return outcome.kind === "accepted"
      ? { kind: "weave", injection: outcome.injection }
      : { kind: "queue_fallback", text: input, from: "weave", reason: outcome.reason }
  }

  // interrupt: only meaningful against a live, non-interrupted turn.
  if (state.currentTurn === null) {
    return { kind: "queue_fallback", text: input, from: "interrupt", reason: "no_active_turn" }
  }
  if (state.isInterrupted) {
    return { kind: "queue_fallback", text: input, from: "interrupt", reason: "interrupted" }
  }
  return { kind: "interrupt", text: input }
}

/**
 * Per-message INVERT (T02 / Codex Cmd-Ctrl+Shift+Enter — "send this ONE message
 * the other way"). The invert toggles between deferred delivery (`queue`) and
 * live delivery into the current turn (`weave` ≈ Codex `steer`):
 *
 *   - `queue`     ⇄ `weave`   — the queue/steer pair (the headline invert).
 *   - `interrupt` →  `queue`  — inverting a barge-in defers it instead (its
 *                               natural opposite is "don't barge in"; there is
 *                               no second live mode to flip to).
 *
 * Pure + total + involutive on the queue/weave pair (`invert(invert(queue))` is
 * `queue`). Used for a ONE-SHOT override of the session's base inbound mode — the
 * base mode is never mutated; the surface applies the inverted mode to the next
 * single message only.
 */
export const invertInboundModeOnce = (base: InboundMode): InboundMode => {
  switch (base) {
    case "queue":
      return "weave"
    case "weave":
      return "queue"
    case "interrupt":
      return "queue"
  }
}

/** Parse a raw env / config string into an {@link InboundMode}. Unrecognised ⇒
 *  `undefined` (caller falls through to its default — usually `queue`). */
export const parseInboundMode = (raw: string | undefined): InboundMode | undefined => {
  if (raw === undefined) return undefined
  const v = raw.trim().toLowerCase()
  return (ALL_INBOUND_MODES as readonly string[]).includes(v) ? (v as InboundMode) : undefined
}
