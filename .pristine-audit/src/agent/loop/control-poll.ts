import { rootMailboxRecipient } from "@/agent/subagent-mailbox"
import type { Message } from "@/llm"
import { errMessage } from "@/shared"
import { cancelSubagent } from "../control-op-handler"
import { drainControlRequests, isControlRequestEnabled } from "../control-request"
import { decideAction } from "../conversation-action"
import { threadId as makeThreadId } from "../follow-up-queue"
import { buildResumeMessage } from "../interrupted-turn"
import type { AgentConfig } from "../types"
import { emitInterrupted, emitResponseQueued, emitSubagentCancel } from "./emit-helpers"

/** §11.5 (08a) — rejection reasons for which a `user_message` is NOT re-queued
 *  (the message is genuinely undeliverable or the user is unwinding): empty
 *  content, an oversize body that must not bypass the size guard, and a
 *  deliberate interrupt. Every OTHER reason (`expected_turn_mismatch`,
 *  `no_active_turn`, `non_steerable_*`) re-routes via injection so the message
 *  is never lost. */
const NO_REQUEUE_REASONS: ReadonlySet<string> = new Set([
  "empty_input",
  "input_too_large",
  "interrupted",
])

/** §11.5 — `resume` consults the SESSION interrupted-turn buffer (not the
 *  per-turn `isInterrupted` gate, which resets every boundary). Restore
 *  re-injects the captured turn through the injection path; nothing buffered ⇒ a
 *  clean no-op. Extracted to keep {@link pollConversationAction} under the
 *  cognitive-complexity cap. */
const handleResumeAction = (cfg: AgentConfig): ConversationActionPollOutcome => {
  const turn = cfg.interruptedTurnBuffer?.take() ?? null
  if (turn === null) {
    cfg.stream.emit({
      type: "recovery",
      reason: "conversation_action_noop",
      detail: "resume:nothing_to_resume",
    })
    return { kind: "continue" }
  }
  return {
    kind: "injection",
    message: { role: "user", content: [{ type: "text", text: buildResumeMessage(turn) }] },
  }
}

/** §11.5 (08a) — a non-empty `user_message` (weave) that missed its target turn
 *  must NOT be silently dropped; re-route via injection (lands next boundary).
 *  {@link NO_REQUEUE_REASONS} stay drop+error. Extracted for complexity. */
const handleRejectedAction = (
  cfg: AgentConfig,
  action: { kind: string; input?: string },
  reason: string,
): ConversationActionPollOutcome => {
  if (
    action.kind === "user_message" &&
    (action.input ?? "").trim().length > 0 &&
    !NO_REQUEUE_REASONS.has(reason)
  ) {
    return {
      kind: "injection",
      message: { role: "user", content: [{ type: "text", text: action.input ?? "" }] },
    }
  }
  cfg.stream.emit({ type: "error", message: `conversation_action rejected: ${reason}` })
  return { kind: "continue" }
}

export type ConversationActionPollOutcome =
  | { kind: "none" }
  | { kind: "injection"; message: Message }
  | { kind: "finish_aborted"; reason: string }
  /** §11.5 — the `summarize` verb: the loop runs an on-demand compaction pass
   *  over working memory (was a dead no-op before this ticket). */
  | { kind: "summarize" }
  | { kind: "continue" }

/**
 * Peer teammate messaging — auto-delivery drain (RFC jun-6, DELTA #1).
 *
 * A tiny DUCK-TYPED port (NOT a direct `@/agent/subagent-mailbox` import from
 * the loop — the loop receives the mailbox via assembly). The host wires a
 * `drainFor` that reads THIS agent's undelivered peer mail (mark-delivered, so
 * the same mail never re-injects across turns — shares the SAME per-recipient
 * delivery cursor as the manual `subagent_read_messages` poll, so a message is
 * delivered exactly ONCE regardless of path), redacts each body (untrusted-as-
 * DATA), and renders it as ONE injected `role:"user"` message — or `null` when
 * the inbox is empty. Bounded by the mailbox's own caps + a per-turn `limit`
 * (the rest stays pending and drains over subsequent turns). Absent ⇒
 * `pollPeerInbox` returns null ⇒ the turn loop is byte-identical (default-OFF).
 */
export interface PeerInboxDrain {
  drainFor(agentId: string): Message | null
}

/** Drain THIS agent's auto-delivered peer mail at the turn-top seam (sibling of
 *  {@link pollFollowUpQueue}). Returns null when no port is wired (default-OFF,
 *  byte-identical) or the inbox is empty. The agent's mailbox identity is its
 *  stable `mailboxAgentId` (the root session leaves it unset ⇒ `"root"`).
 *
 *  The drain PORT stays DUCK-TYPED (received via assembly, never imported here);
 *  only the pure `rootMailboxRecipient` id-resolver is imported — the F1 (jul-15)
 *  SSOT that keeps this READ id byte-identical to the side-agent finding WRITE
 *  recipient (host assembler), so the two ends can never dead-letter again. */
export const pollPeerInbox = (cfg: AgentConfig): Message | null => {
  const port = cfg.peerInbox
  if (port === undefined) return null
  try {
    return port.drainFor(rootMailboxRecipient(cfg.mailboxAgentId))
  } catch (e) {
    cfg.stream.emit({ type: "error", message: `peerInbox.drainFor failed: ${errMessage(e)}` })
    return null
  }
}

/**
 * Control-request drain (ADR-0496, jul-03 A1 activation).
 *
 * The turn-top edge that ACTIVATES the inert `drainControlRequests`/
 * `applyControlEffect` surface (previously ZERO loop callers). Sibling of
 * {@link pollPeerInbox}: default-OFF (absent slot OR gate off ⇒ the port is
 * NEVER polled, byte-identical), BOUNDED + NO-THROW (delegated to
 * `drainControlRequests`, which caps the drain and swallows a hostile
 * port/applier). Effects land on the host via `slot.applier`; nothing is
 * appended to `wm` (control requests mutate runtime state, not the transcript).
 *
 * The gate is load-bearing: a wired slot with `QUANTA_CONTROL_REQUEST` off is a
 * strict no-op — the port is not even queried.
 */
export const pollControlRequests = (cfg: AgentConfig): void => {
  const slot = cfg.controlRequest
  if (slot === undefined) return
  if (!isControlRequestEnabled(slot.env)) return
  try {
    drainControlRequests(slot.port, slot.context, slot.applier)
  } catch (e) {
    // Defense-in-depth: `drainControlRequests` is already NO-THROW, but a future
    // regression must never crash the turn seam.
    cfg.stream.emit({ type: "error", message: `controlRequest drain failed: ${errMessage(e)}` })
  }
}

export const pollFollowUpQueue = (cfg: AgentConfig, sessionId: string): Message | null => {
  const queue = cfg.followUpQueue
  if (queue === undefined) return null
  const tid = makeThreadId(sessionId)
  const reason = cfg.pausedReason?.(sessionId) ?? null
  if (reason !== null) {
    emitResponseQueued(cfg, reason)
    return null
  }
  const popped = queue.popReady(tid, null)
  if (popped === null) return null
  return {
    role: "user",
    content: [{ type: "text", text: popped.ready.content }],
  }
}

export const pollConversationAction = async (
  cfg: AgentConfig,
  taskRegistry: { forceStop(id: string): boolean } | undefined,
): Promise<ConversationActionPollOutcome> => {
  const port = cfg.conversationActionPort
  if (port === undefined) return { kind: "none" }
  let action: ReturnType<typeof port.next>
  try {
    action = port.next()
  } catch (e) {
    const message = errMessage(e)
    cfg.stream.emit({ type: "error", message: `conversationActionPort.next failed: ${message}` })
    return { kind: "none" }
  }
  if (action === undefined) return { kind: "none" }
  // §11.5 — `resume` consults the SESSION interrupted-turn buffer, NOT
  // `decideAction`'s per-turn `isInterrupted` gate (which resets every boundary
  // and so could never accept a cross-turn resume). Restore re-injects the
  // captured turn through the existing `injection` path; nothing buffered ⇒ a
  // clean no-op. Handled before the `activeTurnRef`-required `decideAction` so
  // `resume` works even on a fresh (non-interrupted) turn header.
  if (action.kind === "resume") return handleResumeAction(cfg)
  if (cfg.activeTurnRef === undefined) {
    cfg.stream.emit({
      type: "error",
      message: "conversationActionPort requires activeTurnRef to be wired",
    })
    return { kind: "none" }
  }
  // `decideAction` THROWS `SteerInputInvalidError` on a programming-error action
  // SHAPE (an empty `expectedTurnId`/`reason`/`subagentId`). Today every surface
  // push pre-validates, but that invariant is spread across 5+ call sites + a raw
  // `queue.push`; a single future slip would crash the whole session here (this
  // is the UNCAUGHT loop path). Mirror the `port.next()` guard above + the port
  // contract ("a programming-error throw at the boundary collapses to no action")
  // so the bug CLASS is structurally sealed, not just today's known producer.
  let outcome: ReturnType<typeof decideAction>
  try {
    outcome = decideAction(
      action,
      cfg.activeTurnRef.current,
      { maxInputBytes: 64 * 1024 },
      Date.now(),
    )
  } catch (e) {
    cfg.stream.emit({
      type: "error",
      message: `conversationAction decideAction failed: ${errMessage(e)}`,
    })
    return { kind: "none" }
  }
  if (outcome.kind === "rejected") return handleRejectedAction(cfg, action, outcome.reason)
  if (outcome.kind === "accepted_injection") {
    return {
      kind: "injection",
      message: {
        role: "user",
        content: [{ type: "text", text: outcome.injection.content }],
      },
    }
  }
  const act = outcome.action
  if (act.kind === "cancel") {
    emitInterrupted(cfg, "conversation_action_cancel", act.reason)
    return { kind: "finish_aborted", reason: act.reason }
  }
  if (act.kind === "cancel_subagent") {
    const result = cancelSubagent(taskRegistry, act.subagentId)
    emitSubagentCancel(cfg, act.subagentId, result, "conversation_action")
    if (result === "not_found") {
      cfg.stream.emit({
        type: "error",
        message: `cancel_subagent: unknown subagent id ${act.subagentId}`,
      })
    }
    return { kind: "continue" }
  }
  if (act.kind === "summarize") {
    // §11.5 — surface the request; the loop (turn-iteration) runs the on-demand
    // compaction pass over working memory (it owns `wm`).
    return { kind: "summarize" }
  }
  cfg.stream.emit({
    type: "recovery",
    reason: "conversation_action_noop",
    detail: act.kind,
  })
  return { kind: "continue" }
}
