import type { Message } from "@/llm"
import { errMessage } from "@/shared"
import { cancelSubagent } from "../control-op-handler"
import { decideAction } from "../conversation-action"
import { threadId as makeThreadId } from "../follow-up-queue"
import type { AgentConfig } from "../types"
import { emitInterrupted, emitResponseQueued, emitSubagentCancel } from "./emit-helpers"

export type ConversationActionPollOutcome =
  | { kind: "none" }
  | { kind: "injection"; message: Message }
  | { kind: "finish_aborted"; reason: string }
  | { kind: "continue" }

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
  cfg.stream.emit({
    type: "recovery",
    reason: "conversation_action_noop",
    detail: act.kind,
  })
  return { kind: "continue" }
}
