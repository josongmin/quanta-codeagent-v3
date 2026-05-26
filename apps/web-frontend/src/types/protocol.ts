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

export type SessionStatus =
  | "idle"
  | "running"
  | "awaiting_approval"
  | "failed"
  | "closed"

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

export interface InputAppendCommand
  extends SessionCommandEnvelope<"input.append"> {
  readonly text: string
  readonly images?: readonly ImageBlock[]
}

export interface TurnRunCommand extends SessionCommandEnvelope<"turn.run"> {}

export interface TurnCancelCommand
  extends SessionCommandEnvelope<"turn.cancel"> {}

export interface ApprovalRespondCommand
  extends SessionCommandEnvelope<"approval.respond"> {
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

export interface SessionCreatedEvent
  extends SessionEventEnvelope<"session.created"> {
  readonly capabilityManifest: CapabilityManifest
  /** Active model slug (e.g. `gpt-5`, `claude-sonnet-4-6`). Optional —
   *  populated by runtimes that can introspect their LLM port. */
  readonly model?: string
}

export interface SessionStateUpdatedEvent
  extends SessionEventEnvelope<"session.state.updated"> {
  readonly state: SessionStateView
}

export interface TurnStartedEvent
  extends SessionEventEnvelope<"turn.started"> {
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

export interface TurnCompletedEvent
  extends SessionEventEnvelope<"turn.completed"> {
  readonly outcomeReason: string
  readonly assistantText?: string
  readonly tokenUsage?: TokenUsage
  readonly modelSlug?: string
}

/** Tool invocation life-cycle (mirrors upstream `ToolInvokedEvent`). */
export interface ToolInvokedEvent
  extends SessionEventEnvelope<"tool.invoked"> {
  readonly toolCallId: string
  readonly toolName: string
  readonly argsPreview?: string
}

/** Tool completion life-cycle (mirrors upstream `ToolCompletedEvent`). */
export interface ToolCompletedEvent
  extends SessionEventEnvelope<"tool.completed"> {
  readonly toolCallId: string
  readonly toolName: string
  readonly outcome: "ok" | "error" | "denied" | "timeout"
  readonly resultPreview?: string
  readonly durationMs?: number
}

export interface TurnOutputDeltaEvent
  extends SessionEventEnvelope<"turn.output.delta"> {
  readonly delta: string
}

export interface TurnFailedEvent extends SessionEventEnvelope<"turn.failed"> {
  readonly message: string
}

export interface ApprovalRequestedEvent
  extends SessionEventEnvelope<"approval.requested"> {
  readonly approval: PendingApprovalView
}

export interface ApprovalResolvedEvent
  extends SessionEventEnvelope<"approval.resolved"> {
  readonly approvalId: string
  readonly decision: "approve" | "deny"
}

export interface ArtifactReadyEvent
  extends SessionEventEnvelope<"artifact.ready"> {
  readonly artifact: ArtifactRef
}

export interface SessionClosedEvent
  extends SessionEventEnvelope<"session.closed"> {}

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
export interface SessionWireEnvelope<
  TKind extends "command" | "event" | "snapshot",
  TPayload,
> {
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
