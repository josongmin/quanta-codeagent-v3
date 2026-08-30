import type { ImageBlock } from "@/llm/types"
import type { ItemStreamDeltaKind, ItemStreamItemType } from "@/shared/item-stream"
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

/** Sentinel for a `turn.completed` whose reason could not be resolved.
 *
 *  aug-23 §13: the scheduler used to fall back to `"completed"`, i.e. it
 *  invented a success when it had no reason — the same source-side bug the
 *  Grok-Build audit found. An unresolved outcome is NOT a completion; surfaces
 *  must be able to tell the two apart. */
export const UNKNOWN_OUTCOME_REASON = "unknown"

/** Structured stop category as it rides the wire.
 *
 *  Declared STRUCTURALLY here (not imported from `@/agent/stop-category`) on
 *  purpose: the web-frontend protocol generator hard-errors on `@/*` types
 *  absent a narrowing-manifest entry, and the protocol layer should not depend
 *  on the agent layer. `@/agent`'s `StopCategory` is assignable to this. */
export interface StopCategoryWire {
  readonly kind: string
  readonly reasonCode: string
  readonly hint?: string
}

export interface TurnCompletedEvent extends SessionEventEnvelope<"turn.completed"> {
  readonly outcomeReason: string
  /** Optional structured stop category (aug-23 §13 slice 1c). Absent ⇒ the
   *  event is byte-identical to its pre-slice shape, so existing consumers are
   *  unaffected; surfaces that read it can render an honest stop instead of
   *  re-deriving one from `outcomeReason`. */
  readonly stopCategory?: StopCategoryWire
  readonly assistantText?: string
  readonly tokenUsage?: TokenUsage
  readonly modelSlug?: string
  /** A7 — the session's CUMULATIVE cost view at this turn's close, projected
   *  from the usage authority. A SNAPSHOT: consumers REPLACE their state with
   *  it, never add (the per-turn `tokenUsage` delta above stays for legacy
   *  folds; a snapshot-aware consumer prefers this and must not do both).
   *  `{status:"off"}` means accounting is explicitly disabled. Absent is
   *  reserved for old hosts that predate this wire. */
  readonly costView?: CostSurfaceViewWire
}

/**
 * A7 — the session's CUMULATIVE cost view, projected from the daemon's usage
 * authority after each completed turn.
 *
 * Wire posture: a SNAPSHOT, not a delta — a consumer REPLACES its state with
 * it, never adds. Declared structurally, flat numbers only, so the frontend
 * generator carries it without a narrowing-manifest entry.
 */
export interface CostSurfaceOffWire {
  readonly status: "off"
}

export interface CostSurfaceOnWire {
  readonly status: "on"
  readonly totalUsd: number
  /** Portion of `totalUsd` priced by a stand-in rate (estimate, not measure). */
  readonly estimatedUsd: number
  /** Calls the authority could not price at all — totals are a FLOOR when > 0. */
  readonly unpricedCalls: number
  readonly promptTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly calls: number
  readonly rootUsd: number
  readonly subagentUsd: number
  /** Prior durable totals could not be restored; current numbers begin after
   * the loss boundary and are not lifetime-complete. */
  readonly continuityLost: boolean
  /** Model of the newest recorded call, when any. */
  readonly modelSlug?: string
}

export type CostSurfaceViewWire = CostSurfaceOffWire | CostSurfaceOnWire

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

/**
 * ALBB-04 — dedicated CANCEL terminal wire type (Codex / Claude-Code session
 * protocol norm). A cooperatively-cancelled turn is neither a success
 * (`turn.completed`) nor an error (`turn.failed`); overloading either loses the
 * distinction for any downstream consumer that filters on `event.type`. Both
 * cancel entry points — the host RETURNING `outcome.reason === "aborted"` and
 * the host THROWING an abort — settle through THIS single terminal type, so a
 * cancel is never conflated with success or failure. `message` carries the
 * abort reason for diagnostics (mirrors {@link TurnFailedEvent.message}).
 */
export interface TurnAbortedEvent extends SessionEventEnvelope<"turn.aborted"> {
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
  /** Ticket 04 (wire fidelity opt-in) — the FULL model-visible args, present
   *  ONLY when `QUANTA_SESSION_FULL_FIDELITY` is ON. ADDITIVE-OPTIONAL: absent ⇒
   *  byte-identical default-OFF wire (the 03-A field-shape guard pre-authorized
   *  this `argsFull?` contract). The ipc bridge strips it for any wire peer that
   *  did not negotiate `requestedFidelity` (S3) — the server-side sole defense. */
  readonly argsFull?: string
  /** Ticket 04 — set when the full payload exceeded the size cap and was dropped
   *  (the consumer must fall back to `argsPreview`). */
  readonly fidelityDegraded?: true
}

export interface ToolCompletedEvent extends SessionEventEnvelope<"tool.completed"> {
  readonly toolCallId: string
  readonly toolName: string
  readonly outcome: "ok" | "error" | "denied" | "timeout"
  /** Truncated result preview — same ~256-char cap as `argsPreview`. */
  readonly resultPreview?: string
  /** Wall-clock duration on the host side. */
  readonly durationMs?: number
  /** Ticket 04 — the FULL model-visible result, gate-ON only (see
   *  `ToolInvokedEvent.argsFull`). */
  readonly resultFull?: string
  /** Ticket 04 — full result exceeded the cap and was dropped (see
   *  `ToolInvokedEvent.fidelityDegraded`). */
  readonly fidelityDegraded?: true
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

/**
 * UUX-1-12 (jul-10) — HIGH-VALUE observability events, ADDITIVE to session.v1.
 *
 * Four AgentEvent types the web bridge previously DROPPED now cross as their
 * own NON-PROSE wire types (the ALBB-18 lesson: never splice status text into
 * the `turn.output.delta` prose channel). All four are pure observation — no
 * transcript/state mutation beyond the seq/revision bump — and old clients
 * ignore them gracefully (the frontend decode gate is a membership check; an
 * unknown tag decodes to null and is dropped).
 */

/** Keyed mid-tool progress notice (free-text, clamped host-side; joins the
 *  `tool.invoked` row via `toolCallId`). */
export interface ToolProgressEvent extends SessionEventEnvelope<"tool.progress"> {
  readonly toolCallId: string
  readonly toolName: string
  readonly message: string
}

/** Loop recovery trace (backoff / compact / nudge / empty / malformed). */
export interface TurnRecoveryEvent extends SessionEventEnvelope<"turn.recovery"> {
  readonly reason: string
  readonly detail?: string
}

/** ADR-0075 proactive-compaction marker — the conversation window was folded;
 *  `summary` is clamped host-side (the full archive entry lives in the
 *  session recorder, not on the wire). */
export interface ContextCompactedEvent extends SessionEventEnvelope<"context.compacted"> {
  readonly fromTurnId: string
  readonly toTurnId: string
  readonly summary: string
  readonly ts: number
  readonly tokens: number
}

/** ALBB-21 advisory budget-cap crossing (soft/hard). NON-FATAL — the hard stop
 *  fires via the loop's own epilogue; this is the rendered notice. */
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

export type SessionEvent =
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | ArtifactReadyEvent
  | BudgetBreachEvent
  | ContextCompactedEvent
  | ItemCompletedEvent
  | ItemDeltaEvent
  | ItemStartedEvent
  | SessionClosedEvent
  | SessionCreatedEvent
  | SessionStateUpdatedEvent
  | SkillScopeDecisionEvent
  | ToolCompletedEvent
  | ToolInvokedEvent
  | ToolProgressEvent
  | TurnAbortedEvent
  | TurnCompletedEvent
  | TurnLlmContinuationEvent
  | TurnLlmRequestEvent
  | TurnOutputDeltaEvent
  | TurnFailedEvent
  | TurnRecoveryEvent
  | TurnStartedEvent

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

export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number]

export const isSessionEventType = (value: unknown): value is SessionEventType =>
  typeof value === "string" && (SESSION_EVENT_TYPES as readonly string[]).includes(value)
