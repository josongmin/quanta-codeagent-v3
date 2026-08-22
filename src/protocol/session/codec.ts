import { errMessage } from "@/shared"
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
      `invalid session protocol json: ${errMessage(error)}`,
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

/** Assert a required field is a string; throw on absence or wrong type. A
 *  mistyped scalar (e.g. a numeric `commandId`) silently breaks the
 *  string-keyed dedup/replay maps downstream, so we fail closed here. */
const assertString = (value: Record<string, unknown>, kind: string, key: string): void => {
  if (!(key in value)) throw new SessionProtocolValidationError(`missing_${kind}_${key}`)
  if (typeof value[key] !== "string") {
    throw new SessionProtocolValidationError(`bad_${kind}_${key}_type`)
  }
}

/** Assert a required field is a finite number. A string `"5"` revision is
 *  `!==` a numeric `5` revision downstream and spuriously trips
 *  revision_conflict, wedging the client — so reject non-finite-number. */
const assertFiniteNumber = (value: Record<string, unknown>, kind: string, key: string): void => {
  if (!(key in value)) throw new SessionProtocolValidationError(`missing_${kind}_${key}`)
  const v = value[key]
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new SessionProtocolValidationError(`bad_${kind}_${key}_type`)
  }
}

/** Assert an OPTIONAL field, when present (and not `undefined`), is a finite
 *  number. Absence is allowed; a present mistyped value is rejected. */
const assertOptionalFiniteNumber = (
  value: Record<string, unknown>,
  kind: string,
  key: string,
): void => {
  if (!(key in value) || value[key] === undefined) return
  const v = value[key]
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new SessionProtocolValidationError(`bad_${kind}_${key}_type`)
  }
}

/** Assert an OPTIONAL field, when present (and not `undefined`), is a string. */
const assertOptionalString = (value: Record<string, unknown>, kind: string, key: string): void => {
  if (!(key in value) || value[key] === undefined) return
  if (typeof value[key] !== "string") {
    throw new SessionProtocolValidationError(`bad_${kind}_${key}_type`)
  }
}

/** Assert a required field is a plain object (non-null, non-array). The
 *  snapshot's `state`/`capabilities` carry the entire session view; a scalar
 *  or array there silently corrupts every downstream consumer that reads
 *  nested keys, so fail closed. */
const assertObjectField = (value: Record<string, unknown>, kind: string, key: string): void => {
  if (!(key in value)) throw new SessionProtocolValidationError(`missing_${kind}_${key}`)
  const v = value[key]
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new SessionProtocolValidationError(`bad_${kind}_${key}_type`)
  }
}

/** Assert a required field is a plain object OR `null`. `pendingApproval` is
 *  canonically nullable (`PendingApprovalView | null`); over-correcting to
 *  reject `null` would break legitimate "no pending approval" snapshots, so we
 *  permit `null` but reject scalars/arrays/absence. */
const assertNullableObjectField = (
  value: Record<string, unknown>,
  kind: string,
  key: string,
): void => {
  if (!(key in value)) throw new SessionProtocolValidationError(`missing_${kind}_${key}`)
  const v = value[key]
  if (v === null) return
  if (typeof v !== "object" || Array.isArray(v)) {
    throw new SessionProtocolValidationError(`bad_${kind}_${key}_type`)
  }
}

/** Assert a required field is an array. `openArtifacts` is a `readonly
 *  ArtifactRef[]`; an object/scalar there breaks iteration downstream. */
const assertArrayField = (value: Record<string, unknown>, kind: string, key: string): void => {
  if (!(key in value)) throw new SessionProtocolValidationError(`missing_${kind}_${key}`)
  if (!Array.isArray(value[key])) {
    throw new SessionProtocolValidationError(`bad_${kind}_${key}_type`)
  }
}

const assertCommonMetadata = (value: Record<string, unknown>, kind: "command" | "event"): void => {
  if (kind === "command") {
    assertString(value, kind, "sessionId")
    assertString(value, kind, "commandId")
    assertString(value, kind, "issuedAt")
    assertString(value, kind, "type")
    assertOptionalFiniteNumber(value, kind, "expectedRevision")
    return
  }
  assertString(value, kind, "eventId")
  assertFiniteNumber(value, kind, "seq")
  assertFiniteNumber(value, kind, "revision")
  assertString(value, kind, "emittedAt")
  assertString(value, kind, "type")
  assertOptionalString(value, kind, "causedByCommandId")
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
  // B-MED-7 — the ADDITIVE, optional daemon-continuation stamp on `turn.run`
  // (a mistyped scalar would silently break the string-keyed adoption match,
  // so fail closed; absence is the byte-identical common case).
  if (envelope.payload.type === "turn.run") {
    assertOptionalString(envelope.payload, "command", "causedByApprovalId")
  }
  // RFC-03 C3 — the objective mutation payload carries a closed
  // {@link ObjectiveMutation}. The codec is a LEAF (no `@/objective` value
  // import): it asserts wire-shape sanity — `mutation` is a plain object with a
  // string `kind` — and the HOST authority is the full validator (an unknown
  // kind / malformed payload fails closed at `prepare`/`commit`, never a store
  // effect). Fail here so a scalar/array `mutation` cannot reach the host.
  if (envelope.payload.type === "session.objective.mutate") {
    assertObjectField(envelope.payload, "command", "mutation")
    assertString(envelope.payload.mutation as Record<string, unknown>, "objective_mutation", "kind")
    // The OBJECTIVE-domain CAS target is optional; when present it must be a
    // finite number (a string `"2"` would silently `!==` a numeric revision).
    assertOptionalFiniteNumber(envelope.payload, "command", "expectedObjectiveRevision")
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
  const payload = envelope.payload
  // Route the ordering scalars through the SAME finite-number guard the event
  // path uses (fix #6): an Infinity revision|seq otherwise survives the bare
  // `typeof === "number"` test and wedges revision_conflict downstream.
  assertString(payload, "snapshot", "sessionId")
  assertFiniteNumber(payload, "snapshot", "revision")
  assertFiniteNumber(payload, "snapshot", "seq")
  // The remaining required SessionSnapshotLite fields were previously
  // unchecked — presence/type guard each, mirroring the event path. Match the
  // canonical contract exactly: `pendingApproval` is nullable, `openArtifacts`
  // is an array, `state`/`capabilities` are objects.
  assertObjectField(payload, "snapshot", "state")
  assertObjectField(payload, "snapshot", "capabilities")
  assertNullableObjectField(payload, "snapshot", "pendingApproval")
  assertArrayField(payload, "snapshot", "openArtifacts")
  return payload as unknown as SessionSnapshotLite
}
