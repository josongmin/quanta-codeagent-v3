/**
 * Surface-owned ConversationAction control queue (ADR-0071 wiring).
 *
 * HOISTED to `@/agent` (T02) from `apps/cli/repl` so BOTH the CLI surface AND the
 * web daemon can mint it — the slice-isolation fence (ADR-0024) forbids the web
 * daemon importing `apps/cli/**`, and the conversation-action surface is generic
 * (a FIFO queue + an active-turn-state holder, no CLI-specific deps), so it
 * belongs in a shared library slice. The CLI path re-exports this module for
 * byte-identical back-compat.
 *
 * The agent loop polls `ConversationActionPort.next()` ONCE per turn at the top
 * of the body (pull semantics — see `src/agent/conversation-action.ts`). It also
 * requires `AgentConfig.activeTurnRef` to be wired (the loop errors with an
 * `error` AgentEvent if a port is set without one). This module owns BOTH:
 *
 *   - `port` — the `ConversationActionPort` handed to `AgentConfig`. Its
 *     `next()` drains exactly one queued action FIFO and returns `undefined`
 *     when empty (at-most-once consumption, per the port contract).
 *   - `activeTurnRef` — the `{ current: ActiveTurnState }` holder handed to
 *     `AgentConfig`. The loop overwrites `.current` on every turn boundary
 *     (fresh `currentTurn` header per turn; `currentTurn=null` after finish).
 *     The surface only PRODUCES the holder; the loop is the writer.
 *   - `push*` — the typed enqueue methods slash commands / a follower verb call
 *     mid-turn.
 *
 * Control actions are enqueued WITHOUT an `expectedTurnId` — they target
 * "whatever turn is active" (the opt-in optimistic-concurrency check in
 * `decideAction` is skipped when omitted; see `ControlExpectation`). This keeps
 * the surface honest: the REPL never observed a turn id, so it does not
 * fabricate one. The loop's `decideAction` still gates on an active turn.
 *
 * Default-OFF: this module is only constructed when the opt-in gate is set
 * (`QUANTA_CONVERSATION_ACTIONS`, or the follower-co-control gate); absent ⇒
 * neither the port nor the `activeTurnRef` holder is wired ⇒ the loop never
 * polls (byte-identical).
 */

import type { ConversationAction, ConversationActionPort } from "./conversation-action"
import type { AgentConfig } from "./types"

/** The active-turn-state holder shape the loop owns. Derived from
 *  `AgentConfig` so the surface never deep-imports `@/agent/steering`
 *  (`ActiveTurnState` is not on the `@/agent` barrel). */
type ActiveTurnRefHolder = NonNullable<AgentConfig["activeTurnRef"]>
type ActiveTurnState = ActiveTurnRefHolder["current"]

/** The surface-owned bundle. `port` + `activeTurnRef` are handed to
 *  `AgentConfig` (via `runtimeFacadeCompose`); the `push*` methods are the
 *  slash-command / follower enqueue seam. */
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
  /** §steer (weave mode) — enqueue a mid-turn `user_message` to inject into the
   *  CURRENT turn. The loop's `decideAction` runs the §steer steerability check
   *  (review/compact turns are refused) and injects on the next step. `input`
   *  must be non-empty (the inbound router pre-validates; the loop also gates).
   *  No `expectedTurnId` — targets whatever turn is active (the REPL never
   *  observed a turn id, mirroring the cancel/summarize contract above). */
  pushUserMessage(input: string): void
  /** §11.5 — enqueue a `resume` of the most-recent interrupted turn. The loop
   *  re-injects the captured turn from `AgentConfig.interruptedTurnBuffer` (a
   *  no-op when nothing was interrupted). No `expectedTurnId` — resume consults
   *  the session buffer, not the per-turn state. */
  pushResume(): void
  /** Number of pending (not-yet-drained) actions — for status/observability. */
  pending(): number
}

/** Construct a fresh per-session control surface. Pure — no I/O, no env reads.
 *  The caller (surface-compose / the daemon runtime factory) gates construction
 *  on the opt-in env knob. */
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
    pushResume(): void {
      queue.push({ kind: "resume" })
    },
    pushUserMessage(input: string): void {
      // §steer — `decideAction`'s `user_message` path delegates to `steer()`,
      // which MANDATES a NON-EMPTY `expectedTurnId` (it THROWS `SteerInput
      // InvalidError` on an empty one — a programming-error, not a policy
      // rejection). A steer can only inject into a LIVE turn, so with NO active
      // turn there is nothing to target: DROP it. (The inbound-router weave path
      // never reaches here without a turn, but the DIRECT callers — CLI `/steer`
      // and the web follower dispatcher — can fire while idle; enqueuing an
      // empty-id action would throw out of the uncaught `pollConversationAction`
      // → `decideAction` path and crash the session.) Capture the LIVE turn id:
      // if a new turn started before the loop drains this, the id mismatches and
      // the loop REJECTS (optimistic concurrency) instead of a wrong-turn write.
      const currentTurn = activeTurnRef.current.currentTurn
      if (currentTurn === null) return
      queue.push({ kind: "user_message", input, expectedTurnId: currentTurn.turnId })
    },
    pending(): number {
      return queue.length
    },
  }
}
