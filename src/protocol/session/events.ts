import type { ImageBlock } from "@/llm"
import type {
  ItemStreamDeltaKind,
  ItemStreamItemType,
} from "@/shared/item-stream"
import type {
  LlmSurfaceId,
  LlmTransportId,
  ResponsesContinuationMode,
  ResponsesContinuationPhase,
  ResponsesContinuationReason,
} from "@/shared/llm-route-types"
import type { TurnPolicySnapshot } from "@/shared/turn-policy-types"
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

export interface TurnLlmRequestEvent extends SessionEventEnvelope<"turn.llm.request"> {
  readonly model: string
  readonly provider?: string
  readonly surfaceId?: LlmSurfaceId
  readonly transportId?: LlmTransportId
  readonly authMode?: string
  readonly policy?: TurnPolicySnapshot
}

export interface TurnLlmContinuationEvent extends SessionEventEnvelope<"turn.llm.continuation"> {
  readonly provider?: string
  readonly surfaceId: "openai-responses"
  readonly transportId: LlmTransportId
  readonly phase: ResponsesContinuationPhase
  readonly mode: ResponsesContinuationMode
  readonly reason: ResponsesContinuationReason
  readonly statusCode?: number
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

/**
 * ADR-0512 — skill-scope decision SUMMARY (NOT the interactive escalation pair).
 *
 * The agent loop emits a `skill_scope_decision` AgentEvent for EVERY scope
 * outcome — including the ones the interactive `approval.requested` /
 * `approval.resolved` card NEVER sees: a hard `blocked` (hand-off-required
 * security boundary, denied WITHOUT asking) and a silent auto-decline / steer
 * (no `onConfirm` wired). The CLI renders this as a one-line gray note
 * (`stdout.ts`). Without this wire event the WEB surface produced ZERO feedback
 * for a hard-blocked or silently-declined out-of-scope tool — so the daemon
 * bridge now translates the AgentEvent onto this SessionEvent and the web
 * transcript renders the same gray timeline note.
 *
 * This is the post-decision SUMMARY only; the interactive seam stays the
 * enriched `approval.requested` (`scopeContext`) + `approval.resolved` pair.
 */
export interface SkillScopeDecisionEvent extends SessionEventEnvelope<"skill.scope.decision"> {
  /** The out-of-scope tool the model called. */
  readonly tool: string
  /** The active skill whose allowlist the tool fell outside of. */
  readonly activeSkill: string
  /** The escalation outcome. `blocked` is the gray HARD-LOCK (hand-off-required
   *  security boundary — never a card); the others are the resolved verbs. */
  readonly decision: "allowed" | "declined" | "steered" | "blocked"
  /** Read-only-vs-mutating distinction (same predicate the dispatch + card share). */
  readonly isReadOnly: boolean
}

/**
 * T01 — `item/*` fine-grained streaming (additive to session.v1). A turn's
 * INTERIOR projected as discrete items: `item.started` → 0..N `item.delta` →
 * `item.completed` (Codex app-server parity). Emitted ONLY when
 * `QUANTA_ITEM_STREAM` is on — absent ⇒ no item events, byte-identical legacy
 * (every existing consumer ignores unknown `type`s; the codec is a membership
 * gate, not an exhaustive switch). Payloads mirror {@link ItemStreamCore} in
 * `@/shared/item-stream` — the SINGLE projector that produces them. `itemType`
 * (reasoning / commandExecution / fileChange / tool) + `deltaKind` let a surface
 * branch on a delta alone without joining back to the `started`.
 */
export interface ItemStartedEvent extends SessionEventEnvelope<"item.started"> {
  readonly itemId: string
  readonly itemType: ItemStreamItemType
  /** Monotonic across all items in the turn-stream. */
  readonly itemIndex: number
}

export interface ItemDeltaEvent extends SessionEventEnvelope<"item.delta"> {
  readonly itemId: string
  readonly itemType: ItemStreamItemType
  readonly deltaKind: ItemStreamDeltaKind
  readonly delta: string
}

export interface ItemCompletedEvent extends SessionEventEnvelope<"item.completed"> {
  readonly itemId: string
  readonly itemType: ItemStreamItemType
  /** Accumulated delta body flushed at completion (absent when no deltas). */
  readonly text?: string
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
  | ItemCompletedEvent
  | ItemDeltaEvent
  | ItemStartedEvent
  | SessionClosedEvent
  | SessionCreatedEvent
  | SessionStateUpdatedEvent
  | SkillScopeDecisionEvent
  | ToolCompletedEvent
  | ToolInvokedEvent
  | TurnCompletedEvent
  | TurnLlmContinuationEvent
  | TurnLlmRequestEvent
  | TurnOutputDeltaEvent
  | TurnFailedEvent
  | TurnStartedEvent

export const SESSION_EVENT_TYPES = [
  "approval.requested",
  "approval.resolved",
  "artifact.ready",
  "item.completed",
  "item.delta",
  "item.started",
  "session.closed",
  "session.created",
  "session.state.updated",
  "skill.scope.decision",
  "tool.completed",
  "tool.invoked",
  "turn.completed",
  "turn.llm.continuation",
  "turn.llm.request",
  "turn.output.delta",
  "turn.failed",
  "turn.started",
] as const

export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number]

export const isSessionEventType = (value: unknown): value is SessionEventType =>
  typeof value === "string" && (SESSION_EVENT_TYPES as readonly string[]).includes(value)
