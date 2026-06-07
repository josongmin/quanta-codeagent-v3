import type { Message } from "@/llm"
import { errMessage } from "@/shared"
import { cancelSubagent } from "../control-op-handler"
import { decideAction } from "../conversation-action"
import { threadId as makeThreadId } from "../follow-up-queue"
import { buildResumeMessage } from "../interrupted-turn"
import type { AgentConfig } from "../types"
import { emitInterrupted, emitResponseQueued, emitSubagentCancel } from "./emit-helpers"

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
 *  stable `mailboxAgentId` (the root session leaves it unset ⇒ `"root"`). */
export const pollPeerInbox = (cfg: AgentConfig): Message | null => {
  const port = cfg.peerInbox
  if (port === undefined) return null
  try {
    return port.drainFor(cfg.mailboxAgentId ?? "root")
  } catch (e) {
    cfg.stream.emit({ type: "error", message: `peerInbox.drainFor failed: ${errMessage(e)}` })
    return null
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
  if (action.kind === "resume") {
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
  if (cfg.activeTurnRef === undefined) {
    cfg.stream.emit({
      type: "error",
      message: "conversationActionPort requires activeTurnRef to be wired",
    })
    return { kind: "none" }
  }
  const outcome = decideAction(
    action,
    cfg.activeTurnRef.current,
    { maxInputBytes: 64 * 1024 },
    Date.now(),
  )
  if (outcome.kind === "rejected") {
    cfg.stream.emit({
      type: "error",
      message: `conversation_action rejected: ${outcome.reason}`,
    })
    return { kind: "continue" }
  }
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
