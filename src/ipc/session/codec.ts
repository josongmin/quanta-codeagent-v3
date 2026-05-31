import {
  decodeSessionCommand,
  decodeSessionEvent,
  decodeSessionSnapshot,
  encodeSessionCommand,
  encodeSessionEvent,
  encodeSessionSnapshot,
  isSessionProtocolVersion,
  SESSION_PROTOCOL_VERSION,
  SessionProtocolValidationError,
} from "@/protocol/session"
import type { SessionTransportMessage } from "./types"

/**
 * Control-frame version gate (audit L9 M18c). The `connect` / `rejected`
 * control envelopes are stamped with `version: SESSION_PROTOCOL_VERSION` by
 * {@link encodeControlEnvelope}, but their decoders previously NEVER read it —
 * so a peer speaking a different protocol version could complete the handshake
 * through the negotiation hole, while the sibling command/event/snapshot codec
 * (`@/protocol/session`) already rejects `bad_version`. We close the hole by
 * validating the control-frame version with the SAME gate.
 */
const requireProtocolVersion = (envelope: Record<string, unknown>): void => {
  if (!isSessionProtocolVersion(envelope.version)) {
    throw new SessionProtocolValidationError("bad_version")
  }
}

const expectObject = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SessionProtocolValidationError("transport_envelope_not_object")
  }
  return value as Record<string, unknown>
}

const decodeKind = (raw: string): SessionTransportMessage["kind"] => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    throw new SessionProtocolValidationError("invalid_json")
  }
  const envelope = expectObject(parsed)
  switch (envelope.kind) {
    case "connect":
    case "command":
    case "event":
    case "rejected":
    case "snapshot":
      return envelope.kind
    default:
      throw new SessionProtocolValidationError("bad_transport_kind")
  }
}

const decodeString = (value: unknown, issue: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new SessionProtocolValidationError(issue)
  }
  return value
}

const decodeConnectSessionId = (value: unknown): string => {
  if (typeof value !== "string") {
    throw new SessionProtocolValidationError("bad_transport_session_id")
  }
  // Empty string is the bootstrap discovery sentinel; the bridge still owns
  // canonical session validation and will reject mismatches with the real id.
  return value
}

const decodeOptionalNumber = (value: unknown, issue: string): number | undefined => {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SessionProtocolValidationError(issue)
  }
  return value
}

const encodeControlEnvelope = (
  body: Record<string, unknown> & Pick<SessionTransportMessage, "kind">,
): string =>
  JSON.stringify({
    version: SESSION_PROTOCOL_VERSION,
    ...body,
  })

const decodeConnectMessage = (raw: string): SessionTransportMessage => {
  const envelope = expectObject(JSON.parse(raw) as unknown)
  requireProtocolVersion(envelope)
  const resumeFromSeq = decodeOptionalNumber(
    envelope.resumeFromSeq,
    "bad_transport_resume_from_seq",
  )
  return {
    kind: "connect",
    sessionId: decodeConnectSessionId(envelope.sessionId),
    ...(resumeFromSeq !== undefined ? { resumeFromSeq } : {}),
  }
}

const decodeRejectedMessage = (raw: string): SessionTransportMessage => {
  const envelope = expectObject(JSON.parse(raw) as unknown)
  requireProtocolVersion(envelope)
  const target = decodeString(envelope.target, "bad_transport_reject_target")
  const reason = decodeString(envelope.reason, "bad_transport_reject_reason")
  if (target !== "connect" && target !== "command") {
    throw new SessionProtocolValidationError("bad_transport_reject_target")
  }
  if (
    reason !== "duplicate_command" &&
    reason !== "protocol_validation" &&
    reason !== "revision_conflict" &&
    reason !== "session_id_mismatch"
  ) {
    throw new SessionProtocolValidationError("bad_transport_reject_reason")
  }
  const expectedRevision = decodeOptionalNumber(
    envelope.expectedRevision,
    "bad_transport_expected_revision",
  )
  const actualRevision = decodeOptionalNumber(
    envelope.actualRevision,
    "bad_transport_actual_revision",
  )
  return {
    kind: "rejected",
    sessionId: decodeString(envelope.sessionId, "bad_transport_session_id"),
    target,
    reason,
    ...(typeof envelope.commandId === "string" ? { commandId: envelope.commandId } : {}),
    ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    ...(actualRevision !== undefined ? { actualRevision } : {}),
    ...(typeof envelope.issue === "string" ? { issue: envelope.issue } : {}),
  }
}

export const encodeSessionTransportMessage = (message: SessionTransportMessage): string => {
  switch (message.kind) {
    case "connect":
      return encodeControlEnvelope({
        kind: "connect",
        sessionId: message.sessionId,
        ...(message.resumeFromSeq !== undefined ? { resumeFromSeq: message.resumeFromSeq } : {}),
      })
    case "command":
      return encodeSessionCommand(message.command)
    case "event":
      return encodeSessionEvent(message.event)
    case "rejected":
      return encodeControlEnvelope({
        kind: "rejected",
        sessionId: message.sessionId,
        target: message.target,
        reason: message.reason,
        ...(message.commandId !== undefined ? { commandId: message.commandId } : {}),
        ...(message.expectedRevision !== undefined
          ? { expectedRevision: message.expectedRevision }
          : {}),
        ...(message.actualRevision !== undefined ? { actualRevision: message.actualRevision } : {}),
        ...(message.issue !== undefined ? { issue: message.issue } : {}),
      })
    case "snapshot":
      return encodeSessionSnapshot(message.snapshot)
  }
}

export const decodeSessionTransportMessage = (raw: string): SessionTransportMessage => {
  switch (decodeKind(raw)) {
    case "connect":
      return decodeConnectMessage(raw)
    case "command":
      return { kind: "command", command: decodeSessionCommand(raw) }
    case "event":
      return { kind: "event", event: decodeSessionEvent(raw) }
    case "rejected":
      return decodeRejectedMessage(raw)
    case "snapshot":
      return { kind: "snapshot", snapshot: decodeSessionSnapshot(raw) }
  }
}

export const tryDecodeSessionTransportMessage = (
  raw: string,
): SessionTransportMessage | undefined => {
  try {
    return decodeSessionTransportMessage(raw)
  } catch {
    return undefined
  }
}
