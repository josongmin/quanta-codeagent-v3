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
} from "../types/protocol"

/**
 * Mirror of `SESSION_PROTOCOL_VERSION` upstream. Keep in lock-step with
 * `src/protocol/session/version.ts`. A mismatched version is logged but the
 * envelope is still attempted — the daemon decides the hard rejection arm.
 */
export const SESSION_PROTOCOL_VERSION = "1" as const

const EVENT_TYPES: readonly SessionEventType[] = [
  "approval.requested",
  "approval.resolved",
  "artifact.ready",
  "session.closed",
  "session.created",
  "session.state.updated",
  "turn.completed",
  "turn.failed",
  "turn.started",
]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const isString = (value: unknown): value is string => typeof value === "string"

const isEventTypeTag = (value: unknown): value is SessionEventType =>
  isString(value) && (EVENT_TYPES as readonly string[]).includes(value)

/** Encode a `SessionCommand` to a wire frame string (JSON). */
export const encodeCommandFrame = (command: SessionCommand): string => {
  const envelope: CommandEnvelope = {
    version: SESSION_PROTOCOL_VERSION,
    kind: "command",
    payload: command,
  }
  return JSON.stringify(envelope)
}

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
  // Trust the shape from here — the daemon owns the canonical mapping. A
  // forward-compat field (added upstream first) lands as an unknown extra
  // key and is preserved verbatim through the unsafe cast.
  return payload as unknown as SessionEvent
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
