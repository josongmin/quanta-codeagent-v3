/**
 * Protocol types — LOCAL COPY for the web frontend.
 *
 * Source of truth: `src/protocol/session/` in the main quanta repo
 * (commands.ts, events.ts, snapshot.ts, capabilities.ts, codec.ts).
 *
 * Why a copy and not an import?
 *   The web frontend lives OUTSIDE the bun project's `tsconfig.json#paths`
 *   (different package, different toolchain, different tsconfig). Importing
 *   from `@/protocol/session` would tightly couple the two builds and break
 *   the standalone Vite invocation. The cost is a small duplicated surface;
 *   the benefit is the frontend can be built / shipped independently and
 *   the daemon (Worker B) owns the canonical wire shape.
 *
 * Keep narrow: only the SessionCommand / SessionEvent variants and shapes
 * the UI actually reads or sends. New fields land in the upstream first
 * and get cherry-picked here when the UI starts to consume them.
 *
 * Wire shape (from `src/protocol/session/codec.ts`):
 *   { version: "<SESSION_PROTOCOL_VERSION>", kind: "command"|"event"|"snapshot", payload: <typed payload> }
 *
 * `WireEnvelope` is also used by `src/ipc/event-bridge.ts` for transport-level
 * routing — the daemon translates between the two; the frontend only ever
 * touches the session protocol envelope (one JSON object per WS frame).
 */

/* --- Capabilities ------------------------------------------------------ */

export interface CapabilityManifest {
  readonly approvals: "none" | "operator"
  readonly tools: boolean
  readonly memory: boolean
  readonly artifacts: boolean
  readonly subagents: boolean
  readonly automation: boolean
  readonly shellSnapshot: boolean
  readonly transport: "inproc" | "stdio" | "websocket"
}

/* --- Snapshot views ---------------------------------------------------- */

export type SessionStatus = "idle" | "running" | "awaiting_approval" | "failed" | "closed"

export interface SessionStateView {
  readonly status: SessionStatus
  readonly draftInput: string
  readonly permissionMode: string
  readonly identityMode?: string
  readonly toolProfile?: string
  readonly messageCount: number
  readonly lastUserText?: string
  readonly lastAssistantText?: string
  readonly streamingAssistantText?: string
  readonly lastOutcomeReason?: string
}

/**
 * ADR-0512 P3 — skill-scope escalation context (mirrors `ApprovalScopeContext`
 * in `src/protocol/session/snapshot.ts`). Present ONLY when an approval was
 * raised because the model called a tool OUTSIDE the active skill's allowlist;
 * the `EscalationCard` renders the rich yellow card from it. `risk` is the
 * read-only-vs-mutating distinction (the daemon derives it from the action's
 * `isReadOnly`). Absent ⇒ a plain approval (byte-identical pre-ADR-0512).
 */
export interface ApprovalScopeContext {
  /** The out-of-scope tool the model called (the card's headline tool field). */
  readonly tool: string
  readonly activeSkill: string
  readonly reason: string
  /** The model's one-line rationale (Codex `on-request` justification). */
  readonly justification?: string
  readonly risk: "read-only" | "mutating"
}

export interface PendingApprovalView {
  readonly approvalId: string
  readonly reason: string
  readonly requestedAt: string
  /** ADR-0512 P3 — present ONLY on a skill-scope escalation approval. */
  readonly scopeContext?: ApprovalScopeContext
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

export interface SessionSnapshotLite {
  readonly sessionId: string
  readonly revision: number
  readonly seq: number
  readonly state: SessionStateView
  readonly capabilities: CapabilityManifest
  readonly pendingApproval: PendingApprovalView | null
  readonly openArtifacts: readonly ArtifactRef[]
}

/* --- Command envelopes (client → server) ------------------------------- */

interface SessionCommandEnvelope<TType extends string> {
  readonly sessionId: string
  readonly commandId: string
  readonly issuedAt: string
  readonly expectedRevision?: number
  readonly type: TType
}

/**
 * Image attachment for `input.append`. Mirrors `ImageBlock` upstream
 * (`src/llm/types.ts`). The daemon's `RuntimeSession.input.append` accepts
 * an `images` array; the LLM adapter converts to provider-native shape
 * (OpenAI/ChatGPT: `image_url` data URL; Anthropic: `image` base64 source).
 */
export interface ImageBlock {
  readonly type: "image"
  /** MIME type — `image/png` for hotkey-capture screenshots. */
  readonly mediaType: string
  /** Raw base64 (no `data:` prefix). */
  readonly data: string
}

export interface InputAppendCommand extends SessionCommandEnvelope<"input.append"> {
  readonly text: string
  readonly images?: readonly ImageBlock[]
}

export interface TurnRunCommand extends SessionCommandEnvelope<"turn.run"> {}

export interface TurnCancelCommand extends SessionCommandEnvelope<"turn.cancel"> {}

/**
 * Switch the session's identity/permission mode (mirrors upstream
 * `SessionIdentitySetCommand`). The UI does not emit this yet — it is mirrored
 * so the command contract stays member-for-member with the daemon. */
export interface SessionIdentitySetCommand extends SessionCommandEnvelope<"session.identity.set"> {
  readonly mode: string
}

/**
 * Switch the active tool profile (mirrors upstream
 * `SessionToolProfileSetCommand`). Not yet emitted by the UI; mirrored for the
 * drift contract. */
export interface SessionToolProfileSetCommand
  extends SessionCommandEnvelope<"session.tool_profile.set"> {
  readonly profile: string
}

/**
 * Replace the session transcript (mirrors upstream
 * `SessionTranscriptReplaceCommand`). Upstream carries a `readonly Message[]`;
 * narrowed to `unknown[]` here since the UI does not construct or send it. */
export interface SessionTranscriptReplaceCommand
  extends SessionCommandEnvelope<"session.transcript.replace"> {
  readonly messages: readonly unknown[]
}

export interface ApprovalRespondCommand extends SessionCommandEnvelope<"approval.respond"> {
  readonly approvalId: string
  readonly decision: "approve" | "deny"
  /** ADR-0512 P3 — once-vs-session scope on an `approve` of a skill-scope
   *  ESCALATION (`once` ⇒ dispatch WITHOUT widening). Ignored on a normal
   *  approval. Mirrors the canonical `ApprovalRespondCommand`. */
  readonly scope?: "once" | "session"
  /** ADR-0512 P3 — corrective steer on a `deny` of a skill-scope ESCALATION
   *  (the `deny_and_steer` verb). Absent ⇒ a plain decline. */
  readonly steer?: string
}

/**
 * Closed union — mirrors the canonical `SessionCommand` member-for-member
 * (the drift contract enforces parity). The UI today only EMITS a subset
 * (`input.append` / `turn.run` / `turn.cancel` / `approval.respond`); the
 * identity / transcript / tool-profile variants are mirrored for wire-shape
 * parity and may surface as slash commands in a future iteration.
 */
export type SessionCommand =
  | InputAppendCommand
  | TurnRunCommand
  | TurnCancelCommand
  | SessionIdentitySetCommand
  | SessionToolProfileSetCommand
  | SessionTranscriptReplaceCommand
  | ApprovalRespondCommand

/* --- Event envelopes (server → client) --------------------------------- */

interface SessionEventEnvelope<TType extends string> {
  readonly eventId: string
  readonly seq: number
  readonly revision: number
  readonly emittedAt: string
  readonly causedByCommandId?: string
  readonly type: TType
}

export interface SessionCreatedEvent extends SessionEventEnvelope<"session.created"> {
  readonly capabilityManifest: CapabilityManifest
  /** Active model slug (e.g. `gpt-5`, `claude-sonnet-4-6`). Optional —
   *  populated by runtimes that can introspect their LLM port. */
  readonly model?: string
}

export interface SessionStateUpdatedEvent extends SessionEventEnvelope<"session.state.updated"> {
  readonly state: SessionStateView
}

export interface TurnStartedEvent extends SessionEventEnvelope<"turn.started"> {
  readonly prompt: string
  readonly images?: readonly ImageBlock[]
}

/** Per-turn token accounting. Mirrors `TokenUsage` upstream. */
export interface TokenUsage {
  readonly promptTokens?: number
  readonly completionTokens?: number
  readonly totalTokens?: number
  /** Cost estimate in USD micro-cents (10^-6 USD). */
  readonly costMicroUsd?: number
}

export interface TurnCompletedEvent extends SessionEventEnvelope<"turn.completed"> {
  readonly outcomeReason: string
  readonly assistantText?: string
  readonly tokenUsage?: TokenUsage
  readonly modelSlug?: string
}

/** Tool invocation life-cycle (mirrors upstream `ToolInvokedEvent`). */
export interface ToolInvokedEvent extends SessionEventEnvelope<"tool.invoked"> {
  readonly toolCallId: string
  readonly toolName: string
  readonly argsPreview?: string
}

/** Tool completion life-cycle (mirrors upstream `ToolCompletedEvent`). */
export interface ToolCompletedEvent extends SessionEventEnvelope<"tool.completed"> {
  readonly toolCallId: string
  readonly toolName: string
  readonly outcome: "ok" | "error" | "denied" | "timeout"
  readonly resultPreview?: string
  readonly durationMs?: number
}

export interface TurnOutputDeltaEvent extends SessionEventEnvelope<"turn.output.delta"> {
  readonly delta: string
}

/**
 * LLM request lifecycle (mirrors upstream `TurnLlmRequestEvent`). Emitted when
 * the agent loop dispatches a provider call. The frontend only reads `model` /
 * `provider` to render a model pill; the routing fields below are narrowed to
 * strings here (upstream uses branded `LlmSurfaceId` / `LlmTransportId` and a
 * structured `TurnPolicySnapshot`, none of which the UI inspects). */
export interface TurnLlmRequestEvent extends SessionEventEnvelope<"turn.llm.request"> {
  readonly model: string
  readonly provider?: string
  readonly surfaceId?: string
  readonly transportId?: string
  readonly authMode?: string
  readonly policy?: unknown
}

/**
 * Responses-API continuation lifecycle (mirrors upstream
 * `TurnLlmContinuationEvent`). Emitted while the OpenAI Responses transport
 * resumes a multi-phase stream. The UI does not branch on these today (the
 * reducer treats them as a no-op via `default: return state`); the variant is
 * mirrored so the contract guard and any future continuation UI stay in sync.
 * `phase` / `mode` / `reason` are narrowed to strings (upstream uses closed
 * `Responses*` enums the UI does not enumerate). */
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

/**
 * ADR-0512 — skill-scope decision SUMMARY (mirrors upstream
 * `SkillScopeDecisionEvent`). The agent loop emits this for EVERY scope outcome,
 * including the ones the interactive escalation card never sees: a hard
 * `blocked` (hand-off-required security boundary, denied WITHOUT asking) and a
 * silent auto-decline / steer. The web transcript renders it as a one-line gray
 * note so a hard-blocked / silently-declined out-of-scope tool is not invisible.
 */
export interface SkillScopeDecisionEvent extends SessionEventEnvelope<"skill.scope.decision"> {
  readonly tool: string
  readonly activeSkill: string
  readonly decision: "allowed" | "declined" | "steered" | "blocked"
  readonly isReadOnly: boolean
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
  | SessionCreatedEvent
  | SessionStateUpdatedEvent
  | TurnStartedEvent
  | TurnCompletedEvent
  | TurnOutputDeltaEvent
  | TurnLlmRequestEvent
  | TurnLlmContinuationEvent
  | TurnFailedEvent
  | ToolInvokedEvent
  | ToolCompletedEvent
  | SkillScopeDecisionEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | ArtifactReadyEvent
  | SessionClosedEvent

export type SessionEventType = SessionEvent["type"]
export type SessionCommandType = SessionCommand["type"]

/* --- Transport control envelopes (server → client) --------------------- */

export type SessionRejectTarget = "connect" | "command"

export type SessionRejectReason =
  | "duplicate_command"
  | "protocol_validation"
  | "revision_conflict"
  | "session_id_mismatch"

export interface SessionRejectedFrame {
  readonly sessionId?: string
  readonly target: SessionRejectTarget
  readonly reason: SessionRejectReason
  readonly commandId?: string
  readonly expectedRevision?: number
  readonly actualRevision?: number
  readonly issue?: string
}

/* --- Session wire envelope --------------------------------------------- */

/**
 * Mirrors `SessionWireEnvelope<TPayload>` in the upstream codec — every WS
 * frame is one of these encoded as JSON. The frontend never decodes the
 * IPC `WireEnvelope` (`src/ipc/event-bridge.ts`) — the daemon adapts at
 * the WS boundary.
 */
export interface SessionWireEnvelope<TKind extends "command" | "event" | "snapshot", TPayload> {
  readonly version: string
  readonly kind: TKind
  readonly payload: TPayload
}

export type CommandEnvelope = SessionWireEnvelope<"command", SessionCommand>
export type EventEnvelope = SessionWireEnvelope<"event", SessionEvent>

/* --- UI-only types ----------------------------------------------------- */

/**
 * Local message representation — what the chat panel actually renders.
 * Built up from session events (one TurnStarted → user, TurnCompleted →
 * assistant) plus inline system / error rows.
 */
export interface UiMessage {
  readonly id: string
  readonly role: "user" | "assistant" | "system" | "error"
  readonly text: string
  readonly timestamp: string
  readonly images?: readonly ImageBlock[]
}

export type ConnectionState =
  | { readonly kind: "connecting"; readonly attempt: number }
  | { readonly kind: "connected" }
  | {
      readonly kind: "disconnected"
      readonly attempt: number
      readonly retryInMs: number
      readonly reason?: string
    }
  | { readonly kind: "closed" }

/* --- ADR-0406 — Observability protocol --------------------------------- */

/**
 * Observability pane WS protocol — mirrors `src/protocol/observability/`
 * upstream. Same copy-not-import pattern as the rest of this file: the
 * frontend lives outside the bun tsconfig's `paths`, so we re-state the
 * shapes here. Source of truth: `src/protocol/observability/messages.ts`.
 *
 * The frontend NEVER imports `@/agent/*` runtime — it consumes these shapes
 * structurally via WS frames decoded by `apps/web-frontend/src/ws/`.
 */

export type RunKind = "shell" | "subagent" | "mcp_task" | "exec"
export type RunStatus = "running" | "waiting" | "completed" | "failed" | "stopped"
export type WaitingOnTarget = "user" | "tool" | "network" | "child_agent"

export interface RunArtifact {
  readonly kind: "log" | "stdout" | "summary" | "file"
  readonly ref: string
}

export interface RunEntry {
  readonly id: string
  readonly kind: RunKind
  readonly owner: string
  readonly title: string
  readonly status: RunStatus
  readonly startedAt: number
  readonly lastEventAt: number
  readonly waitingOn?: WaitingOnTarget
  readonly resumeAction?: string
  readonly artifacts: readonly RunArtifact[]
  readonly error?: string
}

export type ObjectiveStatus = "active" | "blocked" | "completed"

export interface SuccessCriterion {
  readonly id: string
  readonly text: string
  readonly met: boolean
}

export interface Blocker {
  readonly id: string
  readonly reason: string
  readonly waitingOn: WaitingOnTarget
  readonly since: number
}

export interface ObjectiveBudget {
  readonly maxTokens?: number
  readonly tokensUsed: number
  readonly maxTurns?: number
  readonly turnsUsed: number
}

export interface Objective {
  readonly threadId: string
  readonly goal: string
  readonly successCriteria: readonly SuccessCriterion[]
  readonly status: ObjectiveStatus
  readonly budget: ObjectiveBudget
  readonly blockers: readonly Blocker[]
  readonly nextActions: readonly string[]
  readonly createdAt: number
  readonly updatedAt: number
}

export type ApprovalKind = "permission" | "clarification" | "escalation"
export type ApprovalDecision = "approve" | "deny" | "modify"
export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "cancelled"

export interface ApprovalRequest {
  readonly id: string
  readonly threadId: string
  readonly kind: ApprovalKind
  readonly reason: string
  readonly proposedAction: string
  readonly resumeStep: string
  readonly options?: readonly string[]
  readonly status: ApprovalStatus
  readonly createdAt: number
  readonly settledAt?: number
  readonly decision?: ApprovalDecision
  readonly modifiedAction?: string
  readonly blockerId?: string
  readonly runEntryId?: string
}

export interface ObservabilitySnapshotMessage {
  readonly kind: "observability.snapshot"
  readonly runs: readonly RunEntry[]
  readonly objective: Objective | null
  readonly approvals: readonly ApprovalRequest[]
  readonly emittedAt: number
}

export interface RunChange {
  readonly id: string
  readonly entry: RunEntry | null
}

export interface ApprovalChange {
  readonly id: string
  readonly approval: ApprovalRequest | null
}

export interface ObservabilityDeltaMessage {
  readonly kind: "observability.delta"
  readonly runChanges?: readonly RunChange[]
  readonly objectiveChanged?: Objective | null
  readonly approvalChanges?: readonly ApprovalChange[]
  readonly emittedAt: number
}

export type ObservabilityMessage = ObservabilitySnapshotMessage | ObservabilityDeltaMessage

/* --- ADR-0440 — Canvas protocol (DiffView + UsageBar) ------------------ */

/**
 * Canvas web-component WS protocol — mirrors `src/protocol/canvas/messages.ts`
 * upstream. Same copy-not-import pattern as the observability protocol: the
 * frontend lives outside the bun tsconfig's `paths`, so the shapes are
 * re-stated here. Source of truth: `src/protocol/canvas/messages.ts`.
 *
 * Default-OFF: these frames only arrive when the daemon's canvas sink is
 * gated ON (`QUANTA_WEB_CANVAS=1`). Absent that, the components below render
 * nothing — chat UI unchanged.
 */

/** Render-side diff line kind (Cursor `DiffLineType`). */
export type DiffLineType = "added" | "removed" | "unchanged"

/** A single render-side diff line (Cursor `DiffLineData`). The daemon
 *  produced these from its CLI diff math — the web bundle never runs diff
 *  math. */
export interface DiffLineData {
  readonly type: DiffLineType
  readonly content: string
  readonly lineNumber?: number
}

/** A tool's file diff, ready to render. */
export interface ToolDiffMessage {
  readonly kind: "tool.diff"
  readonly toolCallId: string
  readonly path?: string
  readonly language?: string
  readonly binary?: boolean
  readonly truncated?: boolean
  readonly moreLines?: number
  readonly lines: readonly DiffLineData[]
  readonly additions: number
  readonly deletions: number
  readonly emittedAt: number
}

/** The latest per-category segmented context usage (mirrors the CLI
 *  `SegmentedUsageView`).
 *
 *  ADR-0448 (RFC-10) adds the OPTIONAL `chars?` field to each segment — the
 *  one additive wire field the rich-layer requests (RFC-10 §4.3). It is the
 *  exact character count `ContextUsageBreakdown.segments[].chars`
 *  (usage-breakdown.ts:96) the CLI computes but never surfaces; the rich
 *  `UsageBreakdownPanel` drilldown shows it. Optional ⇒ RFC-06 byte-compatible:
 *  a daemon that does not serialize it leaves the field `undefined` and the
 *  panel omits the chars readout gracefully. (`color` is NOT wired — the panel
 *  derives the hue from the category id via `CATEGORY_TO_HUE`.) */
export interface ContextUsageMessage {
  readonly kind: "context.usage"
  readonly segments: readonly {
    readonly id: string
    readonly tokens: number
    /** ADR-0448 (RFC-10): exact char count for this category. Optional. */
    readonly chars?: number
  }[]
  readonly total: number
  readonly max: number
  readonly model?: string
  readonly emittedAt: number
}

export type CanvasMessage = ToolDiffMessage | ContextUsageMessage

/* --- QUANTA_WEB_AGENT_STATE — agent-state protocol --------------------- */

/**
 * Agent-state WS protocol — mirrors `src/protocol/agent-state/messages.ts`
 * upstream, member-for-member. Same copy-not-import pattern as the canvas /
 * observability protocols: the frontend lives outside the bun tsconfig's
 * `paths`, so the shapes are re-stated here. Source of truth:
 * `src/protocol/agent-state/messages.ts`.
 *
 * These frames ship the 9 agent-state stream events the in-band session
 * protocol DROPS — plan / mode / tool-progress / compaction / ratelimit — so
 * the web/Tauri surface can render them.
 *
 * Default-OFF: these frames only arrive when the daemon's agent-state sink is
 * gated ON (`QUANTA_WEB_AGENT_STATE=1`). Absent that, no frame ever decodes and
 * the consumers below stay idle — chat UI unchanged.
 */

/** A todo's status (mirrors `AgentStateTodoStatus` upstream). */
export type AgentStateTodoStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "blocked"

/** A single todo inside a plan (mirrors `AgentStateTodo` upstream). */
export interface AgentStateTodo {
  readonly id: string
  readonly title: string
  readonly status: AgentStateTodoStatus
}

/** A read-only plan snapshot (mirrors `AgentStatePlan` upstream). */
export interface AgentStatePlan {
  readonly id: string
  readonly name: string
  readonly version: number
  readonly todos: readonly AgentStateTodo[]
}

/** Plan-delta kind (mirrors `AgentStatePlanDeltaKind` upstream). */
export type AgentStatePlanDeltaKind =
  | "todo_added"
  | "todo_removed"
  | "todo_status_changed"
  | "todo_renamed"
  | "plan_renamed"

/** A read-only plan delta (mirrors `AgentStatePlanDelta` upstream). */
export interface AgentStatePlanDelta {
  readonly kind: AgentStatePlanDeltaKind
  readonly todoId?: string
  readonly todoTitle?: string
  readonly fromStatus?: AgentStateTodoStatus
  readonly toStatus?: AgentStateTodoStatus
  readonly fromName?: string
  readonly toName?: string
}

/** `plan_created` — a full plan snapshot. */
export interface PlanCreatedMessage {
  readonly kind: "plan.created"
  readonly plan: AgentStatePlan
  readonly emittedAt: number
}

/** `plan_snapshot` — a full plan snapshot. */
export interface PlanSnapshotMessage {
  readonly kind: "plan.snapshot"
  readonly plan: AgentStatePlan
  readonly emittedAt: number
}

/** `plan_updated` — an incremental plan delta + the new version. */
export interface PlanUpdatedMessage {
  readonly kind: "plan.updated"
  readonly delta: AgentStatePlanDelta
  readonly version: number
  readonly emittedAt: number
}

/** `plan_user_input_requested` — the plan flow paused to ask the user. */
export interface PlanInputRequestedMessage {
  readonly kind: "plan.input.requested"
  readonly promptId: string
  readonly prompt: string
  readonly choices?: readonly string[]
  readonly emittedAt: number
}

/** `plan_user_input_resolved` — the host answered (or cancelled). */
export interface PlanInputResolvedMessage {
  readonly kind: "plan.input.resolved"
  readonly promptId: string
  readonly decision: "answer" | "cancelled"
  readonly text?: string
  readonly emittedAt: number
}

/** `mode_changed` — a collaboration-mode transition. */
export interface ModeChangedMessage {
  readonly kind: "mode.changed"
  readonly from: "default" | "plan"
  readonly to: "default" | "plan"
  readonly reason?: string
  readonly emittedAt: number
}

/** `tool_progress` — a tool's free-text progress line (id/name renamed to
 *  toolCallId/toolName upstream; message clamped to 256). */
export interface ToolProgressMessage {
  readonly kind: "tool.progress"
  readonly toolCallId: string
  readonly toolName: string
  readonly message: string
  readonly emittedAt: number
}

/** `context_compacted` — a proactive-compaction marker (summary clamped to
 *  256 upstream). */
export interface ContextCompactedMessage {
  readonly kind: "context.compacted"
  readonly fromTurnId: string
  readonly toTurnId: string
  readonly summary: string
  readonly ts: number
  readonly tokens: number
  readonly emittedAt: number
}

/** `ratelimit_snapshot` — a transient ratelimit signal (numbers only). */
export interface RatelimitSnapshotMessage {
  readonly kind: "ratelimit.snapshot"
  readonly requestsRemaining?: number
  readonly requestsResetMs?: number
  readonly tokensRemaining?: number
  readonly tokensResetMs?: number
  readonly observedAt: number
  readonly emittedAt: number
}

/** Closed discriminated union — every agent-state message the wire carries. */
export type AgentStateMessage =
  | PlanCreatedMessage
  | PlanSnapshotMessage
  | PlanUpdatedMessage
  | PlanInputRequestedMessage
  | PlanInputResolvedMessage
  | ModeChangedMessage
  | ToolProgressMessage
  | ContextCompactedMessage
  | RatelimitSnapshotMessage
