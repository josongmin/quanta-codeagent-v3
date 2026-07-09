/**
 * Web agent-state WS protocol — the out-of-band wire codec and message union.
 *
 * Projection ownership now lives in `./projection.ts`; this file keeps the
 * wire schema + codec only so the message contract stays separate from the
 * read-model projection logic.
 */

import type { ItemStreamDeltaKind, ItemStreamItemType } from "@/shared/item-stream"
import type {
  AgentStatePlan,
  AgentStatePlanDelta,
  AgentStateTodo,
  AgentStateTodoStatus,
} from "./projection"

export type { AgentStatePlan, AgentStatePlanDelta, AgentStateTodo, AgentStateTodoStatus }
export type AgentStatePlanDeltaKind = AgentStatePlanDelta["kind"]

/* ------------------------------------------------------------------ */
/* Wire message union (dotted kinds, canvas-style)                     */
/* ------------------------------------------------------------------ */

/** `plan_created` / `plan_snapshot` — a full plan snapshot. */
export interface PlanCreatedMessage {
  readonly kind: "plan.created"
  readonly plan: AgentStatePlan
  readonly emittedAt: number
}

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

/** UUX-2-17 — optional per-choice rich detail riding ALONGSIDE the label-only
 *  `choices` (which stays the pickable-value contract, so label-only clients
 *  keep working). `label` matches the corresponding `choices` entry;
 *  `description` renders as chip subtext. */
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
  /** UUX-2-17 — optional; absent for label-only prompts (wire unchanged). */
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
  readonly fromAgentMode?: string
  readonly toAgentMode?: string
  readonly reason?: string
  readonly emittedAt: number
}

/** `tool_progress` — a tool's free-text progress line. The mapper RENAMES the
 *  source `id`/`name` to `toolCallId`/`toolName` (the surface correlates the
 *  card with the timeline tool row by call-id). `message` is clamped to 256. */
export interface ToolProgressMessage {
  readonly kind: "tool.progress"
  readonly toolCallId: string
  readonly toolName: string
  readonly message: string
  readonly emittedAt: number
}

/** `context_compacted` — a proactive-compaction marker. `summary` is clamped
 *  to 256 (the surface shows the compaction history; the full text is the
 *  synthetic conversation-summary user message). */
export interface ContextCompactedMessage {
  readonly kind: "context.compacted"
  readonly fromTurnId: string
  readonly toTurnId: string
  readonly summary: string
  readonly ts: number
  readonly tokens: number
  readonly emittedAt: number
}

/** `ratelimit_snapshot` — a transient ratelimit signal (numbers + the constant
 *  tag only; never a header VALUE string). */
export interface RatelimitSnapshotMessage {
  readonly kind: "ratelimit.snapshot"
  readonly requestsRemaining?: number
  readonly requestsResetMs?: number
  readonly tokensRemaining?: number
  readonly tokensResetMs?: number
  readonly observedAt: number
  readonly emittedAt: number
}

/** T01 — `item.started` — an interior item opened (reasoning / commandExecution
 *  / fileChange / tool). `itemIndex` is monotonic across the turn-stream. */
export interface ItemStartedMessage {
  readonly kind: "item.started"
  readonly itemId: string
  readonly itemType: ItemStreamItemType
  readonly itemIndex: number
  readonly emittedAt: number
}

/** T01 — `item.delta` — an incremental delta for an open item. */
export interface ItemDeltaMessage {
  readonly kind: "item.delta"
  readonly itemId: string
  readonly itemType: ItemStreamItemType
  readonly deltaKind: ItemStreamDeltaKind
  readonly delta: string
  readonly emittedAt: number
}

/** T01 — `item.completed` — an item closed; `text` is the accumulated body. */
export interface ItemCompletedMessage {
  readonly kind: "item.completed"
  readonly itemId: string
  readonly itemType: ItemStreamItemType
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

/** Closed enum of message tags — keep in lock-step with the union. */
export const AGENT_STATE_MESSAGE_KINDS = [
  "plan.created",
  "plan.snapshot",
  "plan.updated",
  "plan.input.requested",
  "plan.input.resolved",
  "mode.changed",
  "tool.progress",
  "context.compacted",
  "ratelimit.snapshot",
  "item.started",
  "item.delta",
  "item.completed",
] as const

export type AgentStateMessageKind = (typeof AGENT_STATE_MESSAGE_KINDS)[number]

/** Tag guard for wire routing on the receive path. Does NOT deep-validate. */
export const isAgentStateMessageKind = (value: unknown): value is AgentStateMessageKind =>
  typeof value === "string" && (AGENT_STATE_MESSAGE_KINDS as readonly string[]).includes(value)

/** Plain-object check (excludes arrays + nulls). */
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)

/**
 * Best-effort structural guard. Returns true iff `value` has a recognised
 * `kind` tag + a finite `emittedAt`. The encoder enforces full shape on emit;
 * consumers treat unknown fields as forward-compatible (same posture as the
 * canvas `isCanvasMessage` — tag + the universal `emittedAt`, no per-kind deep
 * validation).
 */
export const isAgentStateMessage = (value: unknown): value is AgentStateMessage => {
  if (!isPlainObject(value)) return false
  if (!isAgentStateMessageKind(value.kind)) return false
  if (typeof value.emittedAt !== "number" || !Number.isFinite(value.emittedAt)) return false
  return true
}

/* ------------------------------------------------------------------ */
/* Wire envelope helpers                                               */
/* ------------------------------------------------------------------ */

/** Wire envelope — mirrors the session / observability / canvas `{ version,
 *  kind, payload }` shape so any transport routing those frames routes these. */
export interface AgentStateWireEnvelope {
  readonly version: string
  readonly kind: "agentState"
  readonly payload: AgentStateMessage
}

/** Pinned version tag — bumped on a backward-incompatible change. Decoupled
 *  from the session / observability / canvas protocol versions on purpose. */
export const AGENT_STATE_PROTOCOL_VERSION = "agent-state.v1" as const

/** Encode a typed agent-state message into a JSON wire frame. */
export const encodeAgentStateFrame = (msg: AgentStateMessage): string =>
  JSON.stringify({
    version: AGENT_STATE_PROTOCOL_VERSION,
    kind: "agentState",
    payload: msg,
  } satisfies AgentStateWireEnvelope)

/** Decode a wire frame into an agent-state message, or return null on any
 *  shape mismatch. NO-THROW: callers log + drop on null. Mirrors the canvas
 *  decoder's guards (empty / missing version reject + version-pin gate). */
export const decodeAgentStateFrame = (raw: unknown): AgentStateMessage | null => {
  if (typeof raw !== "string") return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const rec = parsed as Record<string, unknown>
  if (rec.kind !== "agentState") return null
  if (typeof rec.version !== "string" || rec.version.length === 0) return null
  // Gate the protocol version we claim to carry: a v2 emitter to a v1 consumer
  // would otherwise be read with the wrong schema and silently mis-rendered.
  if (rec.version !== AGENT_STATE_PROTOCOL_VERSION) return null
  if (!isAgentStateMessage(rec.payload)) return null
  return rec.payload
}
