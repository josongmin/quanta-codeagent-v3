/**
 * Surface-owned ConversationAction control queue (ADR-0071 wiring).
 *
 * The agent loop polls `ConversationActionPort.next()` ONCE per turn at the top
 * of the body (pull semantics — see `src/agent/conversation-action.ts:372`). It
 * also requires `AgentConfig.activeTurnRef` to be wired (the loop errors with an
 * `error` AgentEvent if a port is set without one). This module owns BOTH:
 *
 *   - `port` — the `ConversationActionPort` handed to `AgentConfig`. Its
 *     `next()` drains exactly one queued action FIFO and returns `undefined`
 *     when empty (at-most-once consumption, per the port contract).
 *   - `activeTurnRef` — the `{ current: ActiveTurnState }` holder handed to
 *     `AgentConfig`. The loop overwrites `.current` on every turn boundary
 *     (fresh `currentTurn` header per turn; `currentTurn=null` after finish).
 *     The surface only PRODUCES the holder; the loop is the writer.
 *   - `push*` — the typed enqueue methods slash commands call mid-turn.
 *
 * MVP scope: only `cancel` + `summarize` are exposed as enqueue methods because
 * only those two have a CLI trigger wired today (`/cancel`, `/summarize-now`).
 * The queue itself accepts any `ConversationAction`, so `cancel_subagent` /
 * `resume` / `user_message` can be added later with no shape change.
 *
 * Control actions are enqueued WITHOUT an `expectedTurnId` — they target
 * "whatever turn is active" (the opt-in optimistic-concurrency check in
 * `decideAction` is skipped when omitted; see `ControlExpectation`). This keeps
 * the surface honest: the REPL never observed a turn id, so it does not
 * fabricate one. The loop's `decideAction` still gates on an active turn.
 *
 * Default-OFF: this module is only constructed when the opt-in gate is set
 * (`QUANTA_CONVERSATION_ACTIONS`); absent ⇒ neither the port nor the
 * `activeTurnRef` holder is wired ⇒ the loop never polls (byte-identical).
 */

import type { AgentConfig } from "@/agent"
import type { ConversationAction, ConversationActionPort } from "@/agent/conversation-action"

/** The active-turn-state holder shape the loop owns. Derived from
 *  `AgentConfig` so the surface never deep-imports `@/agent/steering`
 *  (`ActiveTurnState` is not on the `@/agent` barrel). */
type ActiveTurnRefHolder = NonNullable<AgentConfig["activeTurnRef"]>
type ActiveTurnState = ActiveTurnRefHolder["current"]

/** The surface-owned bundle. `port` + `activeTurnRef` are handed to
 *  `AgentConfig` (via `runtimeFacadeCompose`); the `push*` methods are the
 *  slash-command enqueue seam. */
export interface ConversationActionSurface {
  /** Handed to `AgentConfig.conversationActionPort`. */
  readonly port: ConversationActionPort
  /** Handed to `AgentConfig.activeTurnRef`. The loop OWNS `.current` (writes a
   *  fresh header per turn). The surface only produces the holder + reads it
   *  for status. */
  readonly activeTurnRef: ActiveTurnRefHolder
  /** Enqueue a `cancel` of the whole active turn. `reason` must be non-empty
   *  (the loop's `decideAction` throws otherwise — a programming bug). */
  pushCancel(reason: string): void
  /** Enqueue a mid-turn `summarize` request. */
  pushSummarize(): void
  /** Number of pending (not-yet-drained) actions — for status/observability. */
  pending(): number
}

/** Construct a fresh per-session control surface. Pure — no I/O, no env reads.
 *  The caller (surface-compose) gates construction on the opt-in env knob. */
export const createConversationActionSurface = (): ConversationActionSurface => {
  // FIFO queue. `next()` shifts the head; `push*` appends. The loop drives the
  // cadence (one `next()` per turn), so no locking is needed — JS is single-
  // threaded and the loop + slash dispatch never interleave a single `next()`.
  const queue: ConversationAction[] = []

  // The loop overwrites `.current` on the first turn boundary; this initial
  // snapshot is the "no active turn" state (identical to the loop's own
  // `finishAgentSession` reset shape).
  const activeTurnRef: ActiveTurnRefHolder = {
    current: { currentTurn: null, isInterrupted: false } satisfies ActiveTurnState,
  }

  const port: ConversationActionPort = {
    next(): ConversationAction | undefined {
      // At-most-once: shift removes the head so the SAME action is never
      // re-returned on the next poll (the port contract requires this).
      return queue.shift()
    },
  }

  return {
    port,
    activeTurnRef,
    pushCancel(reason: string): void {
      queue.push({ kind: "cancel", reason })
    },
    pushSummarize(): void {
      queue.push({ kind: "summarize" })
    },
    pending(): number {
      return queue.length
    },
  }
}
