import { isSessionCommandType, type SessionCommand } from "./commands"
import { SessionProtocolValidationError } from "./errors"
import { isSessionEventType, type SessionEvent } from "./events"
import type { SessionSnapshotLite } from "./snapshot"
import { isSessionProtocolVersion, SESSION_PROTOCOL_VERSION } from "./version"

interface SessionWireEnvelope<TPayload> {
  readonly version: string
  readonly kind: "command" | "event" | "snapshot"
  readonly payload: TPayload
}

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw) as unknown
  } catch (error) {
    throw new SessionProtocolValidationError(
      "invalid_json",
      `invalid session protocol json: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

const expectObject = (value: unknown, issue: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SessionProtocolValidationError(issue)
  }
  return value as Record<string, unknown>
}

const parseEnvelope = (
  raw: string,
  kind: SessionWireEnvelope<unknown>["kind"],
): SessionWireEnvelope<Record<string, unknown>> => {
  const top = expectObject(parseJson(raw), "envelope_not_object")
  const version = top.version
  if (!isSessionProtocolVersion(version)) {
    throw new SessionProtocolValidationError("bad_version")
  }
  if (top.kind !== kind) {
    throw new SessionProtocolValidationError(`expected_${kind}_envelope`)
  }
  return {
    version,
    kind,
    payload: expectObject(top.payload, `${kind}_payload_not_object`),
  }
}

const assertCommonMetadata = (value: Record<string, unknown>, kind: "command" | "event"): void => {
  const keys =
    kind === "command"
      ? ["sessionId", "commandId", "issuedAt", "type"]
      : ["eventId", "seq", "revision", "emittedAt", "type"]
  for (const key of keys) {
    if (!(key in value)) throw new SessionProtocolValidationError(`missing_${kind}_${key}`)
  }
}

export const encodeSessionCommand = (command: SessionCommand): string =>
  JSON.stringify({
    version: SESSION_PROTOCOL_VERSION,
    kind: "command",
    payload: command,
  } satisfies SessionWireEnvelope<SessionCommand>)

export const decodeSessionCommand = (raw: string): SessionCommand => {
  const envelope = parseEnvelope(raw, "command")
  assertCommonMetadata(envelope.payload, "command")
  if (!isSessionCommandType(envelope.payload.type)) {
    throw new SessionProtocolValidationError("bad_command_type")
  }
  return envelope.payload as unknown as SessionCommand
}

export const encodeSessionEvent = (event: SessionEvent): string =>
  JSON.stringify({
    version: SESSION_PROTOCOL_VERSION,
    kind: "event",
    payload: event,
  } satisfies SessionWireEnvelope<SessionEvent>)

export const decodeSessionEvent = (raw: string): SessionEvent => {
  const envelope = parseEnvelope(raw, "event")
  assertCommonMetadata(envelope.payload, "event")
  if (!isSessionEventType(envelope.payload.type)) {
    throw new SessionProtocolValidationError("bad_event_type")
  }
  return envelope.payload as unknown as SessionEvent
}

export const encodeSessionSnapshot = (snapshot: SessionSnapshotLite): string =>
  JSON.stringify({
    version: SESSION_PROTOCOL_VERSION,
    kind: "snapshot",
    payload: snapshot,
  } satisfies SessionWireEnvelope<SessionSnapshotLite>)

export const decodeSessionSnapshot = (raw: string): SessionSnapshotLite => {
  const envelope = parseEnvelope(raw, "snapshot")
  if (
    typeof envelope.payload.sessionId !== "string" ||
    typeof envelope.payload.revision !== "number" ||
    typeof envelope.payload.seq !== "number"
  ) {
    throw new SessionProtocolValidationError("bad_snapshot_shape")
  }
  return envelope.payload as unknown as SessionSnapshotLite
}
