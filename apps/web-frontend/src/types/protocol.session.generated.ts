/**
 * GENERATED — DO NOT EDIT.
 *
 * Source of truth: `src/protocol/session/{capabilities,commands,snapshot,events,
 * read-models,version}.ts` in the main quanta repo. Regenerate with:
 *
 *     bun run build:protocol      (-> tools/gen-web-frontend-protocol.ts)
 *
 * This file mirrors the CANONICAL session wire protocol, NARROWED where the
 * frontend toolchain cannot resolve a branded `@/*` type (see the generator's
 * AT_TYPE_NARROWINGS manifest). Editing it by hand will be reverted by the next
 * regeneration and is caught red by
 * `tests/unit/web-frontend-protocol-drift-contract-hellgate.test.ts` (it
 * regenerates in-memory and asserts byte-equality). To change the wire shape,
 * edit `src/protocol/session/` FIRST, then re-run `bun run build:protocol`.
 *
 * The barrel `./protocol.ts` re-exports everything here and adds the UI-only
 * types + the canvas / observability / agent-state protocol mirrors that are
 * outside `@/protocol/session`.
 */

import type { ImageBlock } from "./protocol"

/* --- Value re-declarations the frontend consumes at runtime ---------- */

export const SESSION_PROTOCOL_VERSION = "session.v1" as const

export const SURFACE_READ_MODEL_IDS = ["session", "agentState", "canvas", "observability"] as const

export const SURFACE_READ_MODEL_STATUSES = ["subscribed", "supported", "unsupported"] as const

export type SurfaceReadModelId = (typeof SURFACE_READ_MODEL_IDS)[number]

export type SurfaceReadModelStatus = (typeof SURFACE_READ_MODEL_STATUSES)[number]

export type SurfaceReadModelSupport<TProtocol extends string> =
  | { readonly status: "subscribed" | "supported"; readonly protocol: TProtocol }
  | { readonly status: "unsupported" }

export type SurfaceSubscriptionSupport<TProtocol extends string> =
  | { readonly status: "subscribed"; readonly protocol: TProtocol }
  | { readonly status: "unsupported" }

export type SupportedReadModelSupport<TProtocol extends string> =
  | { readonly status: "supported"; readonly protocol: TProtocol }
  | { readonly status: "unsupported" }

export interface SupportedReadModels {
  readonly session: SupportedReadModelSupport<"session.v1">
  readonly agentState: SupportedReadModelSupport<"agent-state.v1">
  readonly canvas: SupportedReadModelSupport<"canvas.v1">
  readonly observability: SupportedReadModelSupport<"observability.v1">
}

export interface SurfaceSubscription {
  readonly session: SurfaceSubscriptionSupport<"session.v1">
  readonly agentState: SurfaceSubscriptionSupport<"agent-state.v1">
  readonly canvas: SurfaceSubscriptionSupport<"canvas.v1">
  readonly observability: SurfaceSubscriptionSupport<"observability.v1">
}

export const DEFAULT_SESSION_CLIENT_SURFACE_SUBSCRIPTION: SurfaceSubscription = {
  session: { status: "subscribed", protocol: "session.v1" },
  agentState: { status: "subscribed", protocol: "agent-state.v1" },
  canvas: { status: "subscribed", protocol: "canvas.v1" },
  observability: { status: "subscribed", protocol: "observability.v1" },
}

/* --- Capabilities ---------------------------------------------------- */

export interface CapabilityManifest {
  readonly approvals: "none" | "operator"
  readonly tools: boolean
  readonly memory: boolean
  readonly artifacts: boolean
  readonly subagents: boolean
  readonly automation: boolean
  readonly shellSnapshot: boolean
  readonly transport: "inproc" | "stdio" | "websocket"
  readonly serverAutoContinues: boolean
}

export type CapabilityExpectation = Partial<CapabilityManifest>

/* --- Snapshot views -------------------------------------------------- */

export interface PostureLockView {
  readonly reason: string
  readonly producer: string
  readonly label: string
  readonly detail?: string
}

export interface PostureRequestedView {
  readonly preset: string | null
  readonly patch: unknown
}

export interface PostureEffectiveView {
  readonly threadPermission: unknown
  readonly reviewerRoute: string
  readonly askOutsidePlan: boolean
  readonly effectiveMode: string
}

export interface PostureProjectionView {
  readonly revision: number
  readonly requested: PostureRequestedView
  readonly effective: PostureEffectiveView
  readonly locks: readonly PostureLockView[]
}

export type PostureCommandOutcome = {
    readonly ok: true;
} | {
    readonly ok: false;
    readonly kind: "stale_revision";
    readonly expected: number;
    readonly actual: number;
} | {
    readonly ok: false;
    readonly kind: "persist_failed";
    readonly detail: string;
}

export interface ArtifactRef {
  readonly artifactId: string
  readonly kind: string
  readonly mimeType: string
  readonly name?: string
  readonly byteLength?: number
  readonly locator: string
  readonly createdAt: string
}

export interface ApprovalScopeContext {
  readonly tool: string
  readonly activeSkill: string
  readonly reason: string
  readonly justification?: string
  readonly risk: "read-only" | "mutating"
}

export interface ApprovalActor {
  readonly workerId: string
  readonly scope?: string
}

export interface PendingApprovalView {
  readonly approvalId: string
  readonly reason: string
  readonly requestedAt: string
  readonly scopeContext?: ApprovalScopeContext
  readonly actor?: ApprovalActor
}

export interface SessionTokenUsageView {
  readonly promptTokens?: number
  readonly completionTokens?: number
  readonly totalTokens?: number
  readonly costMicroUsd?: number
}

export interface SessionStateView {
  readonly costView?: CostSurfaceViewWire
  readonly status: "idle" | "running" | "awaiting_approval" | "failed" | "closed"
  readonly draftInput: string
  readonly permissionMode: string
  readonly identityMode?: string
  readonly toolProfile?: string
  readonly modelSlug?: string
  readonly messageCount: number
  readonly lastUserText?: string
  readonly lastAssistantText?: string
  readonly streamingAssistantText?: string
  readonly lastOutcomeReason?: string
  readonly lastLlmRequest?: unknown & {
    readonly policy?: unknown;
}
  readonly lastLlmContinuation?: unknown
  readonly lastTokenUsage?: SessionTokenUsageView
  readonly posture?: PostureProjectionView
}

export interface SessionSnapshotLite {
  readonly sessionId: string
  readonly revision: number
  readonly seq: number
  readonly state: SessionStateView
  readonly capabilities: CapabilityManifest
  readonly pendingApproval: PendingApprovalView | null
  readonly openArtifacts: readonly ArtifactRef[]
}

export type SessionStatus = SessionStateView["status"]

/* --- Command envelopes (client -> server) ---------------------------- */

export interface SessionCommandEnvelope<TType extends string> {
  readonly sessionId: string
  readonly commandId: string
  readonly issuedAt: string
  readonly expectedRevision?: number
  readonly type: TType
}

export interface InputAppendCommand extends SessionCommandEnvelope<"input.append"> {
  readonly text: string
  readonly images?: readonly ImageBlock[]
}

export interface TurnRunCommand extends SessionCommandEnvelope<"turn.run"> {
  readonly causedByApprovalId?: string
}

export interface GoalContinuationProvenance {
  readonly kind: "goal-continuation" | "user-requested-goal-work"
  readonly objectiveId: string
  readonly objectiveRevision: number
  readonly attemptId: string
}

export interface TurnSubmitCommand extends SessionCommandEnvelope<"turn.submit"> {
  readonly text: string
  readonly images?: readonly ImageBlock[]
  readonly expectedSessionRevision: number
  readonly provenance: GoalContinuationProvenance
}

export interface TurnCancelCommand extends SessionCommandEnvelope<"turn.cancel"> {}

export interface SessionIdentitySetCommand extends SessionCommandEnvelope<"session.identity.set"> {
  readonly mode: string
}

export interface SessionToolProfileSetCommand extends SessionCommandEnvelope<"session.tool_profile.set"> {
  readonly profile: string
}

export interface SessionPostureSetCommand extends SessionCommandEnvelope<"session.posture.set"> {
  readonly patch: unknown
  readonly scope: PostureCommandScope
  readonly expectedPostureRevision?: number
}

export interface SessionPermissionSetCommand extends SessionCommandEnvelope<"session.permission.set"> {
  readonly mode: string
}

export interface SessionTranscriptReplaceCommand extends SessionCommandEnvelope<"session.transcript.replace"> {
  readonly messages: readonly unknown[]
}

export interface SessionObjectiveMutateCommand extends SessionCommandEnvelope<"session.objective.mutate"> {
  readonly mutation: unknown
  readonly expectedObjectiveRevision?: number
}

export interface SessionSkillSetEnabledCommand extends SessionCommandEnvelope<"session.skill.set_enabled"> {
  readonly name: string
  readonly enabled: boolean
  readonly expectedSkillRevision?: number
}

export interface ApprovalRespondCommand extends SessionCommandEnvelope<"approval.respond"> {
  readonly approvalId: string
  readonly decision: "approve" | "deny"
  readonly scope?: "once" | "session" | "session_prefix"
  readonly selectedHunks?: readonly string[]
  readonly steer?: string
}

export const SESSION_COMMAND_TYPES = [
    "approval.respond",
    "input.append",
    "session.identity.set",
    "session.objective.mutate",
    "session.permission.set",
    "session.posture.set",
    "session.skill.set_enabled",
    "session.transcript.replace",
    "session.tool_profile.set",
    "turn.cancel",
    "turn.run",
    "turn.submit",
] as const

export type TurnExecutionCommand = TurnRunCommand | TurnSubmitCommand

export type PostureCommandScope = "current" | "default"

export type SessionCommand = InputAppendCommand | TurnRunCommand | TurnSubmitCommand | TurnCancelCommand | SessionIdentitySetCommand | SessionTranscriptReplaceCommand | SessionToolProfileSetCommand | SessionPermissionSetCommand | SessionPostureSetCommand | SessionObjectiveMutateCommand | SessionSkillSetEnabledCommand | ApprovalRespondCommand

export type SessionCommandType = (typeof SESSION_COMMAND_TYPES)[number]

/* --- Event envelopes (server -> client) ------------------------------ */

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
  readonly model?: string
}

export interface SessionStateUpdatedEvent extends SessionEventEnvelope<"session.state.updated"> {
  readonly state: SessionStateView
}

export interface TurnStartedEvent extends SessionEventEnvelope<"turn.started"> {
  readonly prompt: string
  readonly images?: readonly ImageBlock[]
}

export interface TokenUsage {
  readonly promptTokens?: number
  readonly completionTokens?: number
  readonly totalTokens?: number
  readonly costMicroUsd?: number
}

export interface StopCategoryWire {
  readonly kind: string
  readonly reasonCode: string
  readonly hint?: string
}

export interface TurnCompletedEvent extends SessionEventEnvelope<"turn.completed"> {
  readonly outcomeReason: string
  readonly stopCategory?: StopCategoryWire
  readonly assistantText?: string
  readonly tokenUsage?: TokenUsage
  readonly modelSlug?: string
  readonly costView?: CostSurfaceViewWire
}

export interface CostSurfaceOffWire {
  readonly status: "off"
}

export interface CostSurfaceOnWire {
  readonly status: "on"
  readonly totalUsd: number
  readonly estimatedUsd: number
  readonly unpricedCalls: number
  readonly promptTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly calls: number
  readonly rootUsd: number
  readonly subagentUsd: number
  readonly continuityLost: boolean
  readonly modelSlug?: string
}

export interface TurnOutputDeltaEvent extends SessionEventEnvelope<"turn.output.delta"> {
  readonly delta: string
}

export interface TurnLlmRequestEvent extends SessionEventEnvelope<"turn.llm.request"> {
  readonly model: string
  readonly provider?: string
  readonly surfaceId?: string
  readonly transportId?: string
  readonly authMode?: string
  readonly policy?: unknown
}

export interface TurnLlmContinuationEvent extends SessionEventEnvelope<"turn.llm.continuation"> {
  readonly provider?: string
  readonly surfaceId: "openai-responses"
  readonly transportId: string
  readonly phase: string
  readonly mode: string
  readonly reason: string
  readonly statusCode?: number
}

export interface TurnFailedEvent extends SessionEventEnvelope<"turn.failed"> {
  readonly message: string
}

export interface TurnAbortedEvent extends SessionEventEnvelope<"turn.aborted"> {
  readonly message: string
}

export interface ToolInvokedEvent extends SessionEventEnvelope<"tool.invoked"> {
  readonly toolCallId: string
  readonly toolName: string
  readonly argsPreview?: string
  readonly argsFull?: string
  readonly fidelityDegraded?: true
}

export interface ToolCompletedEvent extends SessionEventEnvelope<"tool.completed"> {
  readonly toolCallId: string
  readonly toolName: string
  readonly outcome: "ok" | "error" | "denied" | "timeout"
  readonly resultPreview?: string
  readonly durationMs?: number
  readonly resultFull?: string
  readonly fidelityDegraded?: true
}

export interface SkillScopeDecisionEvent extends SessionEventEnvelope<"skill.scope.decision"> {
  readonly tool: string
  readonly activeSkill: string
  readonly decision: "allowed" | "declined" | "steered" | "blocked"
  readonly isReadOnly: boolean
}

export interface ItemStartedEvent extends SessionEventEnvelope<"item.started"> {
  readonly itemId: string
  readonly itemType: string
  readonly itemIndex: number
}

export interface ItemDeltaEvent extends SessionEventEnvelope<"item.delta"> {
  readonly itemId: string
  readonly itemType: string
  readonly deltaKind: string
  readonly delta: string
}

export interface ItemCompletedEvent extends SessionEventEnvelope<"item.completed"> {
  readonly itemId: string
  readonly itemType: string
  readonly text?: string
}

export interface ToolProgressEvent extends SessionEventEnvelope<"tool.progress"> {
  readonly toolCallId: string
  readonly toolName: string
  readonly message: string
}

export interface TurnRecoveryEvent extends SessionEventEnvelope<"turn.recovery"> {
  readonly reason: string
  readonly detail?: string
}

export interface ContextCompactedEvent extends SessionEventEnvelope<"context.compacted"> {
  readonly fromTurnId: string
  readonly toTurnId: string
  readonly summary: string
  readonly ts: number
  readonly tokens: number
}

export interface BudgetBreachEvent extends SessionEventEnvelope<"budget.breach"> {
  readonly severity: "soft" | "hard"
  readonly scope: string
  readonly observed: number
  readonly limit: number
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

export const SESSION_EVENT_TYPES = [
    "approval.requested",
    "approval.resolved",
    "artifact.ready",
    "budget.breach",
    "context.compacted",
    "item.completed",
    "item.delta",
    "item.started",
    "session.closed",
    "session.created",
    "session.state.updated",
    "skill.scope.decision",
    "tool.completed",
    "tool.invoked",
    "tool.progress",
    "turn.aborted",
    "turn.completed",
    "turn.llm.continuation",
    "turn.llm.request",
    "turn.output.delta",
    "turn.failed",
    "turn.recovery",
    "turn.started",
] as const

export type CostSurfaceViewWire = CostSurfaceOffWire | CostSurfaceOnWire

export type SessionEvent = ApprovalRequestedEvent | ApprovalResolvedEvent | ArtifactReadyEvent | BudgetBreachEvent | ContextCompactedEvent | ItemCompletedEvent | ItemDeltaEvent | ItemStartedEvent | SessionClosedEvent | SessionCreatedEvent | SessionStateUpdatedEvent | SkillScopeDecisionEvent | ToolCompletedEvent | ToolInvokedEvent | ToolProgressEvent | TurnAbortedEvent | TurnCompletedEvent | TurnLlmContinuationEvent | TurnLlmRequestEvent | TurnOutputDeltaEvent | TurnFailedEvent | TurnRecoveryEvent | TurnStartedEvent

export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number]
