/**
 * Type-safe helpers for the session wire envelope.
 *
 * Source of truth for the envelope shape: `src/protocol/session/codec.ts`.
 * We re-implement narrow encode/decode/validate here (rather than depend on
 * the upstream module) so the frontend bundle stays self-contained.
 *
 * Validation philosophy: defensive — every byte across the WS boundary is
 * untrusted. We check the structural shape (envelope keys + payload type
 * tag) and reject anything that doesn't match. We deliberately do NOT
 * deep-validate every nested field — the daemon owns the canonical shape
 * and the UI degrades gracefully when an unrecognised field appears.
 */

import type {
  AgentStateMessage,
  CanvasMessage,
  CommandEnvelope,
  EventEnvelope,
  ObservabilityMessage,
  SurfaceSubscription,
  SessionCommand,
  SessionEvent,
  SessionEventType,
  SessionRejectedFrame,
  SessionSnapshotLite,
} from "../types/protocol"

/**
 * Mirror of `SESSION_PROTOCOL_VERSION` upstream. Keep in lock-step with
 * `src/protocol/session/version.ts`. A mismatched version is logged but the
 * envelope is still attempted — the daemon decides the hard rejection arm.
 */
export const SESSION_PROTOCOL_VERSION = "session.v1" as const

const EVENT_TYPES: readonly SessionEventType[] = [
  "approval.requested",
  "approval.resolved",
  "artifact.ready",
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
]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const isString = (value: unknown): value is string => typeof value === "string"
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value)

const isEventTypeTag = (value: unknown): value is SessionEventType =>
  isString(value) && (EVENT_TYPES as readonly string[]).includes(value)

const OBSERVABILITY_MESSAGE_KINDS = [
  "observability.snapshot",
  "observability.delta",
] as const satisfies readonly ObservabilityMessage["kind"][]

const isObservabilityMessageKind = (value: unknown): value is ObservabilityMessage["kind"] =>
  isString(value) && (OBSERVABILITY_MESSAGE_KINDS as readonly string[]).includes(value)

const isNullableRecord = (value: unknown): boolean => value === null || isRecord(value)

const isRunChanges = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.every(
    (item) => isRecord(item) && isString(item.id) && (item.entry === null || isRecord(item.entry)),
  )

const isApprovalChanges = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.every(
    (item) =>
      isRecord(item) && isString(item.id) && (item.approval === null || isRecord(item.approval)),
  )

const isObservabilityMessage = (value: unknown): value is ObservabilityMessage => {
  if (!isRecord(value)) return false
  if (!isObservabilityMessageKind(value.kind)) return false
  if (!isNumber(value.emittedAt)) return false
  if (value.kind === "observability.snapshot") {
    return (
      Array.isArray(value.runs) &&
      Array.isArray(value.approvals) &&
      isNullableRecord(value.objective)
    )
  }
  if (value.runChanges !== undefined && !isRunChanges(value.runChanges)) return false
  if (value.approvalChanges !== undefined && !isApprovalChanges(value.approvalChanges)) return false
  if (value.objectiveChanged !== undefined && !isNullableRecord(value.objectiveChanged))
    return false
  return true
}

const isSessionStateView = (value: unknown): boolean => {
  if (!isRecord(value)) return false
  if (!isString(value.status)) return false
  if (!isString(value.draftInput)) return false
  if (!isString(value.permissionMode)) return false
  if (!isNumber(value.messageCount)) return false
  if (value.lastUserText !== undefined && !isString(value.lastUserText)) {
    return false
  }
  if (value.lastAssistantText !== undefined && !isString(value.lastAssistantText)) {
    return false
  }
  if (value.streamingAssistantText !== undefined && !isString(value.streamingAssistantText)) {
    return false
  }
  if (value.lastOutcomeReason !== undefined && !isString(value.lastOutcomeReason)) {
    return false
  }
  return true
}

/** Encode a `SessionCommand` to a wire frame string (JSON).
 *
 * Wire shape (canonical, matches `src/protocol/session/codec.ts` upstream):
 *   `{ version: "session.v1", kind: "command", payload: SessionCommand }`
 */
export const encodeCommandFrame = (command: SessionCommand): string => {
  const envelope: CommandEnvelope = {
    version: SESSION_PROTOCOL_VERSION,
    kind: "command",
    payload: command,
  }
  return JSON.stringify(envelope)
}

/** Encode a handshake `connect` control frame. The control envelope is FLAT
 *  (no `payload` wrap) — `{version, kind:"connect", sessionId}` — matching
 *  `encodeControlEnvelope` in `src/ipc/session/codec.ts`. When the client
 *  does not yet know the canonical session id it sends a non-empty discovery
 *  sentinel, provoking a `rejected` connect frame whose `sessionId` carries
 *  the server-minted id.
 *
 *  Resume-on-reconnect: when `resumeFromSeq` is provided the daemon replays
 *  only the events with `seq > resumeFromSeq` (or falls back to a full
 *  snapshot if that seq is older than its in-memory replay window). It is
 *  OMITTED on the first connect / discovery handshake so that path stays
 *  byte-identical to the legacy 3-key frame and the client receives a full
 *  snapshot. `resumeFromSeq === 0` is a real bootstrap seq and IS emitted
 *  (we gate on `undefined`, not falsiness). */
export const encodeConnectFrame = (
  sessionId: string,
  resumeFromSeq?: number,
  surfaceSubscription?: SurfaceSubscription,
): string =>
  JSON.stringify({
    version: SESSION_PROTOCOL_VERSION,
    kind: "connect",
    sessionId,
    ...(resumeFromSeq !== undefined ? { resumeFromSeq } : {}),
    ...(surfaceSubscription !== undefined ? { surfaceSubscription } : {}),
  })

/**
 * Best-effort decode of a wire frame into a `SessionEvent`. Returns null on
 * any structural mismatch (callers should log + drop). The frontend never
 * receives commands — only events / snapshots / rejections — but we keep
 * the decode surface symmetric for future use.
 */
export const decodeEventFrame = (raw: unknown): SessionEvent | null => {
  if (!isString(raw)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  if (parsed.kind !== "event") return null
  const payload = parsed.payload
  if (!isRecord(payload)) return null
  if (!isEventTypeTag(payload.type)) return null
  if (typeof payload.seq !== "number" || !Number.isFinite(payload.seq)) {
    return null
  }
  if (!isString(payload.eventId) || payload.eventId.length === 0) return null
  return payload as unknown as SessionEvent
}

/** Decode a `rejected` handshake-reply frame. Wire shape (flat control
 *  envelope, NOT payload-wrapped):
 *    `{version, kind:"rejected", sessionId, target, reason, commandId?, ...}`
 *  The daemon sends this when the client's connect-frame sessionId doesn't
 *  match the server's session; `sessionId` is the canonical id to adopt. */
export const decodeRejectedFrame = (raw: unknown): SessionRejectedFrame | null => {
  if (!isString(raw)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  if (parsed.kind !== "rejected") return null
  const target = parsed.target
  if (target !== "connect" && target !== "command") return null
  const reason = parsed.reason
  if (
    reason !== "duplicate_command" &&
    reason !== "protocol_validation" &&
    reason !== "revision_conflict" &&
    reason !== "session_id_mismatch"
  ) {
    return null
  }
  const sessionId = isString(parsed.sessionId) ? parsed.sessionId : undefined
  return {
    target,
    reason,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(isString(parsed.commandId) ? { commandId: parsed.commandId } : {}),
    ...(typeof parsed.expectedRevision === "number"
      ? { expectedRevision: parsed.expectedRevision }
      : {}),
    ...(typeof parsed.actualRevision === "number" ? { actualRevision: parsed.actualRevision } : {}),
    ...(isString(parsed.issue) ? { issue: parsed.issue } : {}),
  }
}

/** Decode a snapshot control frame into the UI-visible snapshot view. */
export const decodeSnapshotFrame = (raw: unknown): SessionSnapshotLite | null => {
  if (!isString(raw)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  if (parsed.kind !== "snapshot") return null
  const payload = parsed.payload
  if (!isRecord(payload)) return null
  if (!isString(payload.sessionId)) return null
  if (!isNumber(payload.revision)) return null
  if (!isNumber(payload.seq)) return null
  if (!isSessionStateView(payload.state)) return null
  if (!isRecord(payload.capabilities)) return null
  if (
    payload.pendingApproval !== null &&
    payload.pendingApproval !== undefined &&
    !isRecord(payload.pendingApproval)
  ) {
    return null
  }
  if (!Array.isArray(payload.openArtifacts)) return null
  return payload as unknown as SessionSnapshotLite
}

/** Decode an `observability` envelope into the snapshot/delta payload. */
export const decodeObservabilityFrame = (raw: unknown): ObservabilityMessage | null => {
  if (!isString(raw)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  if (parsed.kind !== "observability") return null
  if (!isString(parsed.version) || parsed.version.length === 0) return null
  return isObservabilityMessage(parsed.payload) ? parsed.payload : null
}

/* ------------------------------------------------------------------ */
/* Canvas channel (ADR-0440) — tool.diff / context.usage frames        */
/* ------------------------------------------------------------------ */

/**
 * Mirror of `CANVAS_PROTOCOL_VERSION` upstream (`src/protocol/canvas/
 * messages.ts`). Decoupled from the session/observability protocol versions
 * on purpose — a v2 canvas emitter to a v1 consumer is rejected (read with
 * the wrong schema ⇒ silent mis-render), same gate as the daemon's decoder.
 */
export const CANVAS_PROTOCOL_VERSION = "canvas.v1" as const

const CANVAS_MESSAGE_KINDS = ["tool.diff", "context.usage"] as const

const isCanvasMessageKind = (value: unknown): value is CanvasMessage["kind"] =>
  isString(value) && (CANVAS_MESSAGE_KINDS as readonly string[]).includes(value)

const isToolDiffShape = (rec: Record<string, unknown>): boolean =>
  isString(rec.toolCallId) &&
  Array.isArray(rec.lines) &&
  isNumber(rec.additions) &&
  isNumber(rec.deletions)

const isContextUsageShape = (rec: Record<string, unknown>): boolean =>
  Array.isArray(rec.segments) && isNumber(rec.total) && isNumber(rec.max)

/** Best-effort structural guard for a canvas message payload. Mirrors
 *  `isCanvasMessage` upstream — tag + per-kind minimal shape, no deep
 *  field validation (unknown fields are forward-compatible). */
const isCanvasMessage = (value: unknown): value is CanvasMessage => {
  if (!isRecord(value)) return false
  if (!isCanvasMessageKind(value.kind)) return false
  if (!isNumber(value.emittedAt)) return false
  return value.kind === "tool.diff" ? isToolDiffShape(value) : isContextUsageShape(value)
}

/**
 * Decode a `canvas` wire frame into a typed canvas message, or null on any
 * shape mismatch. Wire envelope (mirrors the observability `{version, kind,
 * payload}` shape): `{ version: "canvas.v1", kind: "canvas", payload }`.
 * NO-THROW: the client logs + drops on null.
 */
export const decodeCanvasFrame = (raw: unknown): CanvasMessage | null => {
  if (!isString(raw)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  if (parsed.kind !== "canvas") return null
  if (!isString(parsed.version) || parsed.version.length === 0) return null
  // Gate the version we claim to carry: a v2 emitter read with the v1 schema
  // would be silently mis-rendered.
  if (parsed.version !== CANVAS_PROTOCOL_VERSION) return null
  return isCanvasMessage(parsed.payload) ? parsed.payload : null
}

/* ------------------------------------------------------------------ */
/* Agent-state channel (QUANTA_WEB_AGENT_STATE) — plan / mode /         */
/* tool-progress / compaction / ratelimit frames                       */
/* ------------------------------------------------------------------ */

/**
 * Mirror of `AGENT_STATE_PROTOCOL_VERSION` upstream
 * (`src/protocol/agent-state/messages.ts`). Decoupled from the other protocol
 * versions on purpose — a v2 agent-state emitter to a v1 consumer is rejected
 * (read with the wrong schema ⇒ silent mis-render), same gate as the daemon's
 * decoder.
 */
export const AGENT_STATE_PROTOCOL_VERSION = "agent-state.v1" as const

const AGENT_STATE_MESSAGE_KINDS = [
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

const isAgentStateMessageKind = (value: unknown): value is AgentStateMessage["kind"] =>
  isString(value) && (AGENT_STATE_MESSAGE_KINDS as readonly string[]).includes(value)

/** Best-effort structural guard for an agent-state message payload. Mirrors
 *  `isAgentStateMessage` upstream — tag + the universal `emittedAt`, no per-kind
 *  deep validation (unknown fields are forward-compatible). */
const isAgentStateMessage = (value: unknown): value is AgentStateMessage => {
  if (!isRecord(value)) return false
  if (!isAgentStateMessageKind(value.kind)) return false
  return isNumber(value.emittedAt)
}

/**
 * Decode an `agentState` wire frame into a typed agent-state message, or null
 * on any shape mismatch. Wire envelope (mirrors the canvas / observability
 * `{version, kind, payload}` shape): `{ version: "agent-state.v1", kind:
 * "agentState", payload }`. NO-THROW: the client logs + drops on null.
 */
export const decodeAgentStateFrame = (raw: unknown): AgentStateMessage | null => {
  if (!isString(raw)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  if (parsed.kind !== "agentState") return null
  if (!isString(parsed.version) || parsed.version.length === 0) return null
  // Gate the version we claim to carry: a v2 emitter read with the v1 schema
  // would be silently mis-rendered.
  if (parsed.version !== AGENT_STATE_PROTOCOL_VERSION) return null
  return isAgentStateMessage(parsed.payload) ? parsed.payload : null
}

/**
 * Loose detection that does not throw — used by the client to log unknown
 * envelope kinds (snapshot, rejected control frames) without crashing.
 */
export const peekEnvelopeKind = (raw: unknown): string | null => {
  if (!isString(raw)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  return isString(parsed.kind) ? parsed.kind : null
}

/**
 * Type predicate exported for tests + handler narrowing — used by the React
 * hooks to switch on a fully-typed event.
 */
export const isEventEnvelope = (value: unknown): value is EventEnvelope => {
  if (!isRecord(value)) return false
  if (value.kind !== "event") return false
  const payload = value.payload
  if (!isRecord(payload)) return false
  return isEventTypeTag(payload.type)
}
