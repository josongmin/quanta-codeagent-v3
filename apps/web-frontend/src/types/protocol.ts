/**
 * Protocol types — BARREL for the web frontend.
 *
 * The SESSION wire protocol (commands / events / snapshot / capabilities /
 * read-models / version) is GENERATED from the canonical daemon SSOT
 * (`src/protocol/session/`) into `./protocol.session.generated.ts` by
 * `bun run build:protocol` (tools/gen-web-frontend-protocol.ts) and re-exported
 * verbatim below — ticket 03-B replaced the old hand copy so the two can never
 * DRIFT (the generator narrows the branded `@/*` types the frontend toolchain
 * cannot resolve; `web-frontend-protocol-drift-contract-hellgate.test.ts`
 * asserts the committed generated file byte-equals a fresh regeneration).
 *
 * This barrel adds the shapes that are OUTSIDE `@/protocol/session` and so are
 * NOT generated:
 *   - `ImageBlock` — mirrors `@/llm`'s image block (the generated session types
 *     reference it by name; declared here so the bundle stays self-contained);
 *   - the transport control envelopes (`SessionRejectedFrame`, the
 *     `SessionWireEnvelope` family) — mirror `codec.ts`;
 *   - UI-only types (`UiMessage`, `ConnectionState`) the chat panel renders;
 *   - the canvas / observability / agent-state protocol mirrors (their own
 *     `src/protocol/{canvas,observability,agent-state}/` SSOTs), kept in sync by
 *     the union-membership guards in the same hellgate.
 *
 * Wire shape (from `src/protocol/session/codec.ts`):
 *   { version: "<SESSION_PROTOCOL_VERSION>", kind: "command"|"event"|"snapshot", payload: <typed payload> }
 */

export * from "./protocol.session.generated"

import type { SessionCommand, SessionEvent, StopCategoryWire } from "./protocol.session.generated"

/* --- @/llm mirror (referenced by the generated session types) ---------- */

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
  /** aug-23 §13 slice 1d — WHY the turn stopped, when it stopped for a reason
   *  worth showing. Absent on ordinary rows and on events from a producer that
   *  predates the field, so existing rendering is unchanged. */
  readonly stopCategory?: StopCategoryWire
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

export type ObjectiveStatus =
  | "active"
  | "paused"
  | "usage_limited"
  | "budget_limited"
  | "blocked"
  | "completed"

export interface SuccessCriterion {
  readonly kind: "manual" | "checked"
  readonly id: string
  readonly text: string
  readonly met: boolean
  readonly completion?: { readonly source: "manual" | "verifier" }
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
  readonly objectiveId: string
  readonly createdBy: "user" | "model" | "system" | "continuation"
  readonly verifiedSourceDigest?: string
  readonly verificationState?: "current" | "stale"
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

/** RFC-12 (deferred) SURFACE B — an anchored review comment, projected from the
 *  agent-emitted `ReviewFinding` (`src/tool/git/review-diff.ts` +
 *  `review-anchor.ts`) for render over the matching diff line. The daemon maps
 *  the finding's `anchor.line` (1-based, new-side) → the render-side line so the
 *  overlay lands on the right row. Only the render-relevant, honesty-safe fields
 *  cross the wire — the anchor's hashes/hunkId (an apply-target concern) do NOT.
 *
 *  ADDITIVE + OPTIONAL on `ToolDiffMessage` (below): a daemon that does not
 *  serialize `anchors` leaves the field `undefined`, and the DiffView overlay is
 *  absent (byte-identical to the pre-RFC-12 diff render). */
export interface DiffAnchorComment {
  /** 1-based line the comment addresses (matches a `DiffLineData.lineNumber` on
   *  the new/added side). */
  readonly line: number
  /** Reviewer disposition (RFC09-2) — closed union, mirrors `ReviewVerdict`.
   *  Optional (an un-dispositioned finding still overlays). */
  readonly verdict?: "confirmed" | "plausible"
  /** Open-ended kebab category slug (RFC09-2). Free string. */
  readonly category?: string
  /** One-line reviewer summary (RFC09-2 `shortSummary`), else the finding body. */
  readonly summary: string
  /** Finding severity (drives the badge hue). */
  readonly severity?: "info" | "warning" | "error"
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
  /** RFC-12 (deferred) SURFACE B — anchored review comments to overlay on the
   *  diff. ADDITIVE + OPTIONAL: absent (a daemon that never serializes it) ⇒ the
   *  DiffPanel/DiffView render is byte-identical to the pre-RFC-12 diff. */
  readonly anchors?: readonly DiffAnchorComment[] | undefined
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

/**
 * A2 — a rich artifact is READY to preview (mirrors upstream
 * `ArtifactReadyMessage` in `src/protocol/canvas/messages.ts`). The daemon emits
 * this alongside the session `artifact.ready` event so the Canvas surface can
 * render a preview card WITHOUT a session-event round-trip. Carries ONLY the
 * opaque `quanta-artifact://<id>` locator — the surface fetches the actual bytes
 * from the daemon's `GET /artifact/<id>` route (the host resolves the locator to
 * JAILED bytes read-only; the absolute fs path never reaches the wire).
 */
export interface ArtifactReadyMessage {
  readonly kind: "artifact.ready"
  readonly artifactId: string
  readonly artifactKind: string
  readonly mimeType: string
  readonly locator: string
  readonly name?: string
  readonly emittedAt: number
}

export type CanvasMessage = ToolDiffMessage | ContextUsageMessage | ArtifactReadyMessage

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
export type AgentStateTodoStatus = "pending" | "in_progress" | "completed" | "cancelled" | "blocked"

/** A single todo inside a plan (mirrors `AgentStateTodo` upstream). */
export interface AgentStateTodo {
  readonly id: string
  readonly title: string
  readonly status: AgentStateTodoStatus
  /** RFC12-1 — the DAG blocked-by edges (todo ids this one waits on), mirroring
   *  the OPTIONAL `TodoReadonlyMirror.dependencies` upstream. Absent ⇒ the legacy
   *  3-field shape (byte-stable); present ⇒ the PlanPanel graph toggle can draw
   *  the dependency arrows. Never used for control flow — a pure render input. */
  readonly dependencies?: readonly string[]
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

/** UUX-2-17 — optional per-choice rich detail riding alongside the label-only
 *  `choices` (mirrors upstream `PlanInputChoiceDetail`). `label` matches the
 *  corresponding `choices` entry; `description` renders as chip subtext. */
export interface PlanInputChoiceDetail {
  readonly label: string
  readonly description?: string
}

/** `plan_user_input_requested` — the plan flow paused to ask the user. */
export interface PlanInputRequestedMessage {
  readonly kind: "plan.input.requested"
  readonly promptId: string
  readonly prompt: string
  readonly choices?: readonly string[]
  /** UUX-2-17 — optional; absent for label-only prompts. */
  readonly choiceDetails?: readonly PlanInputChoiceDetail[]
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

/** T01 — `item.*` fine-grained item stream on the agent-state channel (mirrors
 *  upstream `Item*Message`). `itemType` / `deltaKind` narrowed to strings. */
export interface ItemStartedMessage {
  readonly kind: "item.started"
  readonly itemId: string
  readonly itemType: string
  readonly itemIndex: number
  readonly emittedAt: number
}

export interface ItemDeltaMessage {
  readonly kind: "item.delta"
  readonly itemId: string
  readonly itemType: string
  readonly deltaKind: string
  readonly delta: string
  readonly emittedAt: number
}

export interface ItemCompletedMessage {
  readonly kind: "item.completed"
  readonly itemId: string
  readonly itemType: string
  readonly text?: string
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
  | ItemStartedMessage
  | ItemDeltaMessage
  | ItemCompletedMessage
