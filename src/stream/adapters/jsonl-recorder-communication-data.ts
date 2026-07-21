import type { AgentEvent } from "../types"

export type CommunicationDataEvent = Extract<
  AgentEvent,
  { type: "peer_message" | "subagent_delivery" }
>

export const isCommunicationDataEvent = (e: AgentEvent): e is CommunicationDataEvent =>
  e.type === "peer_message" || e.type === "subagent_delivery"

/** Durable peer mail and delivery-lifecycle payloads. Bodies are already
 * sanitized at their emit boundary; recorder redaction still applies on top. */
export const communicationDataOf = (e: CommunicationDataEvent): Record<string, unknown> => {
  if (e.type === "peer_message") {
    return {
      reason: "peer_message",
      from: e.from,
      to: e.to,
      messageKind: e.kind,
      body: e.body,
      provenance: e.provenance.source,
      ...(e.provenance.source === "side-agent" ? { daemonId: e.provenance.daemonId } : {}),
      ...(e.correlationId !== undefined ? { correlationId: e.correlationId } : {}),
      sentAt: e.sentAt,
    }
  }
  return {
    reason: "subagent_delivery",
    deliveryId: e.deliveryId,
    phase: e.phase,
    requestedMode: e.requestedMode,
    status: e.status,
    ...(e.phase === "admitted"
      ? { targetTaskId: e.targetTaskId, targetTurnId: e.targetTurnId }
      : {}),
    ...("effectiveMode" in e ? { effectiveMode: e.effectiveMode } : {}),
    ...("targetTurnId" in e ? { targetTurnId: e.targetTurnId } : {}),
    ...("reason" in e ? { deliveryReason: e.reason } : {}),
    ...("messageId" in e ? { messageId: e.messageId } : {}),
  }
}
