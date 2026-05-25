import type { CapabilityManifest } from "./capabilities"
import type { ArtifactRef, PendingApprovalView, SessionStateView } from "./snapshot"

export interface SessionEventEnvelope<TType extends string> {
  readonly eventId: string
  readonly seq: number
  readonly revision: number
  readonly emittedAt: string
  readonly causedByCommandId?: string
  readonly type: TType
}

export interface SessionCreatedEvent extends SessionEventEnvelope<"session.created"> {
  readonly capabilityManifest: CapabilityManifest
}

export interface SessionStateUpdatedEvent extends SessionEventEnvelope<"session.state.updated"> {
  readonly state: SessionStateView
}

export interface TurnStartedEvent extends SessionEventEnvelope<"turn.started"> {
  readonly prompt: string
}

export interface TurnCompletedEvent extends SessionEventEnvelope<"turn.completed"> {
  readonly outcomeReason: string
}

export interface TurnFailedEvent extends SessionEventEnvelope<"turn.failed"> {
  readonly message: string
}

export interface ApprovalRequestedEvent extends SessionEventEnvelope<"approval.requested"> {
  readonly approval: PendingApprovalView
}

export interface ApprovalResolvedEvent extends SessionEventEnvelope<"approval.resolved"> {
  readonly approvalId: string
  readonly decision: "approve" | "deny"
}

export interface ArtifactReadyEvent extends SessionEventEnvelope<"artifact.ready"> {
  readonly artifact: ArtifactRef
}

export interface SessionClosedEvent extends SessionEventEnvelope<"session.closed"> {}

export type SessionEvent =
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | ArtifactReadyEvent
  | SessionClosedEvent
  | SessionCreatedEvent
  | SessionStateUpdatedEvent
  | TurnCompletedEvent
  | TurnFailedEvent
  | TurnStartedEvent

export const SESSION_EVENT_TYPES = [
  "approval.requested",
  "approval.resolved",
  "artifact.ready",
  "session.closed",
  "session.created",
  "session.state.updated",
  "turn.completed",
  "turn.failed",
  "turn.started",
] as const

export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number]

export const isSessionEventType = (value: unknown): value is SessionEventType =>
  typeof value === "string" && (SESSION_EVENT_TYPES as readonly string[]).includes(value)
