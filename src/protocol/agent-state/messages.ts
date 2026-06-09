/**
 * Web agent-state WS protocol — the out-of-band channel that ships the 9
 * already-emitted agent-state stream events to the web/Tauri surface so it can
 * render plan / mode / tool-progress / compaction / ratelimit state that the
 * in-band session protocol currently DROPS.
 *
 * Cloned posture from `src/protocol/canvas/messages.ts` (ADR-0440):
 *   - Two closed messages on the wire (`{ version, kind:"agentState", payload }`)
 *     so any transport that routes canvas / observability frames routes these too.
 *   - SELF-CONTAINED slice fence: this module imports NO `@/agent` runtime, NO
 *     `@/stream` (the cross-slice ban — RFC §3.1), and NO CLI surface. The 9
 *     stream-event shapes are RE-MIRRORED structurally here (same field names +
 *     shapes as `AgentEvent` in `@/stream/types.ts`) so `agentEventToMessage`
 *     can map them WITHOUT back-referencing `@/stream`. Adding a field to one of
 *     the 9 `AgentEvent` variants MUST re-shape the matching mirror here.
 *   - codec `encode/decode` with the SAME guards as the canvas codec: empty /
 *     missing-version reject + a pinned `AGENT_STATE_PROTOCOL_VERSION` gate so a
 *     v2 emitter read with the v1 schema is rejected (never silently mis-rendered).
 *   - NO-THROW decode: callers log + drop on null.
 *
 * The frontend keeps a structural COPY of these shapes
 * (`apps/web-frontend/src/types/protocol.ts`), same copy-not-import pattern as
 * the canvas + observability protocols (the web bundle lives outside the bun
 * tsconfig `paths`).
 *
 * Default-OFF: these frames are only ever emitted when the daemon's
 * agent-state sink is gated ON (`QUANTA_WEB_AGENT_STATE=1`). Absent that, the
 * stream tap is never installed, no frame is ever encoded ⇒ the frontend
 * renders nothing ⇒ chat UI byte-identical.
 */

/* ------------------------------------------------------------------ */
/* Structural mirrors of the 9 source `AgentEvent` variants            */
/* (keep in lock-step with `@/stream/types.ts` — slice fence forbids    */
/*  the import).                                                        */
/* ------------------------------------------------------------------ */

/** Mirrors `TodoStatusMirror` in `@/stream/types.ts`. */
export type AgentStateTodoStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "blocked"

/** Mirrors `TodoReadonlyMirror` in `@/stream/types.ts`. */
export interface AgentStateTodo {
  readonly id: string
  readonly title: string
  readonly status: AgentStateTodoStatus
}

/** Mirrors `PlanReadonlyMirror` in `@/stream/types.ts`. */
export interface AgentStatePlan {
  readonly id: string
  readonly name: string
  readonly version: number
  readonly todos: readonly AgentStateTodo[]
}

/** Mirrors `PlanDeltaKindMirror` in `@/stream/types.ts`. */
export type AgentStatePlanDeltaKind =
  | "todo_added"
  | "todo_removed"
  | "todo_status_changed"
  | "todo_renamed"
  | "plan_renamed"

/** Mirrors `PlanDeltaReadonlyMirror` in `@/stream/types.ts`. */
export interface AgentStatePlanDelta {
  readonly kind: AgentStatePlanDeltaKind
  readonly todoId?: string
  readonly todoTitle?: string
  readonly fromStatus?: AgentStateTodoStatus
  readonly toStatus?: AgentStateTodoStatus
  readonly fromName?: string
  readonly toName?: string
}

/**
 * Structural mirror of the 9 source stream events this channel ships. Each
 * member mirrors the matching `AgentEvent` variant in `@/stream/types.ts`
 * field-for-field (the slice fence forbids importing the real union). The pure
 * {@link agentEventToMessage} mapper accepts a duck-typed `{ type }` shape and
 * narrows on `type`; this declared union documents the EXACT input contract.
 */
export type AgentStateObservation =
  | { readonly type: "plan_created"; readonly plan: AgentStatePlan }
  | {
      readonly type: "plan_updated"
      readonly delta: AgentStatePlanDelta
      readonly version: number
    }
  | { readonly type: "plan_snapshot"; readonly plan: AgentStatePlan }
  | {
      readonly type: "plan_user_input_requested"
      readonly promptId: string
      readonly prompt: string
      readonly choices?: readonly string[]
    }
  | {
      readonly type: "plan_user_input_resolved"
      readonly promptId: string
      readonly decision: "answer" | "cancelled"
      readonly text?: string
    }
  | {
      readonly type: "mode_changed"
      readonly from: "default" | "plan"
      readonly to: "default" | "plan"
      readonly reason?: string
    }
  | {
      readonly type: "tool_progress"
      readonly id: string
      readonly name: string
      readonly message: string
    }
  | {
      readonly type: "context_compacted"
      readonly fromTurnId: string
      readonly toTurnId: string
      readonly summary: string
      readonly ts: number
      readonly tokens: number
    }
  | {
      readonly type: "ratelimit_snapshot"
      readonly requestsRemaining?: number
      readonly requestsResetMs?: number
      readonly tokensRemaining?: number
      readonly tokensResetMs?: number
      readonly observedAt: number
    }

/**
 * The duck-typed sink the agent slice wires into `AgentConfig.onAgentState`.
 * Mirror of the `ToolDiffSink` posture: `@/agent/types.ts` references THIS
 * shape structurally (a `{ capture(ev): void }`); the web-daemon composition
 * root provides the concrete sink. NO-THROW by contract.
 */
export interface AgentStateSink {
  capture(event: AgentStateObservation): void
}

/* ------------------------------------------------------------------ */
/* Tap filter SSOT — the 9 source event-type strings                   */
/* ------------------------------------------------------------------ */

/**
 * The 9 source `AgentEvent.type` tags this channel ships. SSOT for the stream
 * tap's filter (`AGENT_STATE_TYPES.has(event.type)`) — the tap installs the
 * sink-capture ONLY for these types; every other event passes through verbatim.
 */
export const AGENT_STATE_TYPES: ReadonlySet<string> = new Set<string>([
  "plan_created",
  "plan_updated",
  "plan_snapshot",
  "plan_user_input_requested",
  "plan_user_input_resolved",
  "mode_changed",
  "tool_progress",
  "context_compacted",
  "ratelimit_snapshot",
])

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

/* ------------------------------------------------------------------ */
/* Pure mapper: source `AgentEvent` → wire `AgentStateMessage`         */
/* ------------------------------------------------------------------ */

/** Max chars for the free-text `tool_progress.message` + `context_compacted.
 *  summary` fields — the surface renders a one-line card, and an unbounded
 *  free-text field is a cheap wire-bloat / DoS vector. */
const TEXT_CLAMP = 256

/** Clamp a free-text string to {@link TEXT_CLAMP} chars (no ellipsis — the
 *  surface adds its own affordance). Defensive: a non-string degrades to "". */
const clamp = (s: string): string => (s.length > TEXT_CLAMP ? s.slice(0, TEXT_CLAMP) : s)

/**
 * Pure mapper — convert one of the 9 source stream observations into its wire
 * message, stamping a fresh `emittedAt`. Returns null for any non-mapped event
 * type (defensive: the tap only ever feeds the 9, but a forward-compat caller
 * may pass through more). Does the `id`→`toolCallId` / `name`→`toolName` rename
 * for `tool_progress` and clamps the two free-text fields to 256 chars.
 *
 * Pure: imports NO `@/agent` / `@/stream` runtime; the input is the local
 * structural mirror {@link AgentStateObservation}.
 */
export const agentEventToMessage = (ev: AgentStateObservation): AgentStateMessage | null => {
  const emittedAt = Date.now()
  switch (ev.type) {
    case "plan_created":
      return { kind: "plan.created", plan: ev.plan, emittedAt }
    case "plan_snapshot":
      return { kind: "plan.snapshot", plan: ev.plan, emittedAt }
    case "plan_updated":
      return { kind: "plan.updated", delta: ev.delta, version: ev.version, emittedAt }
    case "plan_user_input_requested":
      return {
        kind: "plan.input.requested",
        promptId: ev.promptId,
        prompt: ev.prompt,
        ...(ev.choices !== undefined ? { choices: ev.choices } : {}),
        emittedAt,
      }
    case "plan_user_input_resolved":
      return {
        kind: "plan.input.resolved",
        promptId: ev.promptId,
        decision: ev.decision,
        ...(ev.text !== undefined ? { text: ev.text } : {}),
        emittedAt,
      }
    case "mode_changed":
      return {
        kind: "mode.changed",
        from: ev.from,
        to: ev.to,
        ...(ev.reason !== undefined ? { reason: ev.reason } : {}),
        emittedAt,
      }
    case "tool_progress":
      // Rename id→toolCallId / name→toolName; clamp the free-text message.
      return {
        kind: "tool.progress",
        toolCallId: ev.id,
        toolName: ev.name,
        message: clamp(ev.message),
        emittedAt,
      }
    case "context_compacted":
      return {
        kind: "context.compacted",
        fromTurnId: ev.fromTurnId,
        toTurnId: ev.toTurnId,
        summary: clamp(ev.summary),
        ts: ev.ts,
        tokens: ev.tokens,
        emittedAt,
      }
    case "ratelimit_snapshot":
      return {
        kind: "ratelimit.snapshot",
        ...(ev.requestsRemaining !== undefined
          ? { requestsRemaining: ev.requestsRemaining }
          : {}),
        ...(ev.requestsResetMs !== undefined ? { requestsResetMs: ev.requestsResetMs } : {}),
        ...(ev.tokensRemaining !== undefined ? { tokensRemaining: ev.tokensRemaining } : {}),
        ...(ev.tokensResetMs !== undefined ? { tokensResetMs: ev.tokensResetMs } : {}),
        observedAt: ev.observedAt,
        emittedAt,
      }
    default:
      return null
  }
}
