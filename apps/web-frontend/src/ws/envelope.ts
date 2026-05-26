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
  CommandEnvelope,
  EventEnvelope,
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
  "tool.completed",
  "tool.invoked",
  "turn.completed",
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

const isSessionStateView = (value: unknown): boolean => {
  if (!isRecord(value)) return false
  if (!isString(value.status)) return false
  if (!isString(value.draftInput)) return false
  if (!isString(value.permissionMode)) return false
  if (!isNumber(value.messageCount)) return false
  if (
    value.lastUserText !== undefined &&
    !isString(value.lastUserText)
  ) {
    return false
  }
  if (
    value.lastAssistantText !== undefined &&
    !isString(value.lastAssistantText)
  ) {
    return false
  }
  if (
    value.streamingAssistantText !== undefined &&
    !isString(value.streamingAssistantText)
  ) {
    return false
  }
  if (
    value.lastOutcomeReason !== undefined &&
    !isString(value.lastOutcomeReason)
  ) {
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
 *  the server-minted id. */
export const encodeConnectFrame = (sessionId: string): string =>
  JSON.stringify({
    version: SESSION_PROTOCOL_VERSION,
    kind: "connect",
    sessionId,
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
export const decodeRejectedFrame = (
  raw: unknown,
): SessionRejectedFrame | null => {
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
    ...(typeof parsed.actualRevision === "number"
      ? { actualRevision: parsed.actualRevision }
      : {}),
    ...(isString(parsed.issue) ? { issue: parsed.issue } : {}),
  }
}

/** Decode a snapshot control frame into the UI-visible snapshot view. */
export const decodeSnapshotFrame = (
  raw: unknown,
): SessionSnapshotLite | null => {
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
