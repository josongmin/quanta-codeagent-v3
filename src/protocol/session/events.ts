import type { ImageBlock } from "@/llm"
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
  /** Optional active model slug (e.g. `gpt-5`, `claude-sonnet-4-6`). Carried
   *  here so the web surface can render a model pill without a second
   *  round-trip. Defaults to undefined when the runtime cannot inspect its
   *  LLM port (e.g. test harness). */
  readonly model?: string
}

export interface SessionStateUpdatedEvent extends SessionEventEnvelope<"session.state.updated"> {
  readonly state: SessionStateView
}

export interface TurnStartedEvent extends SessionEventEnvelope<"turn.started"> {
  readonly prompt: string
  readonly images?: readonly ImageBlock[]
}

/** Per-turn token accounting. Adapters populate as the provider stream
 *  reports it; absent fields stay undefined (we never fabricate). */
export interface TokenUsage {
  readonly promptTokens?: number
  readonly completionTokens?: number
  readonly totalTokens?: number
  /** Optional per-provider cost estimate in USD micro-cents (10^-6 USD).
   *  Integer so it survives JSON round-trips without float drift. */
  readonly costMicroUsd?: number
}

export interface TurnCompletedEvent extends SessionEventEnvelope<"turn.completed"> {
  readonly outcomeReason: string
  readonly assistantText?: string
  readonly tokenUsage?: TokenUsage
  readonly modelSlug?: string
}

export interface TurnOutputDeltaEvent extends SessionEventEnvelope<"turn.output.delta"> {
  readonly delta: string
}

export interface TurnFailedEvent extends SessionEventEnvelope<"turn.failed"> {
  readonly message: string
}

/** Tool invocation life-cycle. Emitted by the agent loop whenever a tool
 *  call is dispatched. Closed enum on `outcome` so the UI can render
 *  stable status pills without a per-tool branch. */
export interface ToolInvokedEvent extends SessionEventEnvelope<"tool.invoked"> {
  /** Stable identifier for the call — UI joins `tool.completed` to this. */
  readonly toolCallId: string
  /** Tool name (e.g. `bash`, `read_file`). */
  readonly toolName: string
  /** Truncated argument preview — at most ~256 chars; the full args live in
   *  the artifact / session log. */
  readonly argsPreview?: string
}

export interface ToolCompletedEvent extends SessionEventEnvelope<"tool.completed"> {
  readonly toolCallId: string
  readonly toolName: string
  readonly outcome: "ok" | "error" | "denied" | "timeout"
  /** Truncated result preview — same ~256-char cap as `argsPreview`. */
  readonly resultPreview?: string
  /** Wall-clock duration on the host side. */
  readonly durationMs?: number
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
  | ToolCompletedEvent
  | ToolInvokedEvent
  | TurnCompletedEvent
  | TurnOutputDeltaEvent
  | TurnFailedEvent
  | TurnStartedEvent

export const SESSION_EVENT_TYPES = [
  "approval.requested",
  "approval.resolved",
  "artifact.ready",
  "session.closed",
  "session.created",
  "session.state.updated",
  "tool.completed",
  "tool.invoked",
  "turn.completed",
  "turn.output.delta",
  "turn.failed",
  "turn.started",
] as const

export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number]

export const isSessionEventType = (value: unknown): value is SessionEventType =>
  typeof value === "string" && (SESSION_EVENT_TYPES as readonly string[]).includes(value)
