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

export interface PendingApprovalView {
  readonly approvalId: string
  readonly reason: string
  readonly requestedAt: string
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

export interface ApprovalRespondCommand extends SessionCommandEnvelope<"approval.respond"> {
  readonly approvalId: string
  readonly decision: "approve" | "deny"
}

/**
 * Closed union — UI sends only the subset it actually emits today.
 * Upstream defines a few more (identity / transcript / tool profile)
 * that future iterations may surface as slash commands.
 */
export type SessionCommand =
  | InputAppendCommand
  | TurnRunCommand
  | TurnCancelCommand
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
  | SessionCreatedEvent
  | SessionStateUpdatedEvent
  | TurnStartedEvent
  | TurnCompletedEvent
  | TurnOutputDeltaEvent
  | TurnFailedEvent
  | ToolInvokedEvent
  | ToolCompletedEvent
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
