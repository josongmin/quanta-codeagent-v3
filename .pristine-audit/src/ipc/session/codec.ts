import {
  decodeSessionCommand,
  decodeSessionEvent,
  decodeSessionSnapshot,
  encodeSessionCommand,
  encodeSessionEvent,
  encodeSessionSnapshot,
  isSessionProtocolVersion,
  isSurfaceSubscription,
  SESSION_PROTOCOL_VERSION,
  SessionProtocolValidationError,
} from "@/protocol/session"
import type { SessionTransportConnectMessage, SessionTransportMessage } from "./types"

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
    case "heartbeat":
    case "resumed":
    case "fidelity":
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
  // Ticket 05 — the served-marker opt-in: absent or literal `true` only (our
  // encoder never writes anything else; a foreign `false`/garbage is refused).
  if (envelope.resumeAck !== undefined && envelope.resumeAck !== true) {
    throw new SessionProtocolValidationError("bad_transport_resume_ack")
  }
  const resumeAck = envelope.resumeAck
  // Ticket 04 — closed single-value enum: absent or literal "full" only.
  if (envelope.requestedFidelity !== undefined && envelope.requestedFidelity !== "full") {
    throw new SessionProtocolValidationError("bad_transport_requested_fidelity")
  }
  const requestedFidelity = envelope.requestedFidelity
  const surfaceSubscription =
    envelope.surfaceSubscription === undefined
      ? undefined
      : isSurfaceSubscription(envelope.surfaceSubscription)
        ? envelope.surfaceSubscription
        : (() => {
            throw new SessionProtocolValidationError("bad_transport_surface_subscription")
          })()
  return {
    kind: "connect",
    sessionId: decodeConnectSessionId(envelope.sessionId),
    ...(resumeFromSeq !== undefined ? { resumeFromSeq } : {}),
    ...(resumeAck === true ? { resumeAck: true as const } : {}),
    ...(requestedFidelity === "full" ? { requestedFidelity: "full" as const } : {}),
    ...(surfaceSubscription !== undefined ? { surfaceSubscription } : {}),
  }
}

/** Ticket 05 — the `resumed` served-marker (see the type docblock in
 *  `types.ts`). Same control-envelope discipline as every sibling: version
 *  gate first, then a strict field-by-field decode — an already-shipped peer
 *  never reaches this decoder (its closed-kind gate drops the frame). */
const decodeResumedMessage = (raw: string): SessionTransportMessage => {
  const envelope = expectObject(JSON.parse(raw) as unknown)
  requireProtocolVersion(envelope)
  const sessionId = decodeString(envelope.sessionId, "bad_transport_session_id")
  const servedThroughSeq = decodeOptionalNumber(
    envelope.servedThroughSeq,
    "bad_transport_served_through_seq",
  )
  if (servedThroughSeq === undefined) {
    throw new SessionProtocolValidationError("bad_transport_served_through_seq")
  }
  const mode = envelope.mode
  if (mode !== "replay" && mode !== "snapshot") {
    throw new SessionProtocolValidationError("bad_transport_resume_mode")
  }
  return { kind: "resumed", sessionId, servedThroughSeq, mode }
}

/** Ticket 04 — the `fidelity` negotiation ack (see the type docblock in
 *  `types.ts`). Same control-envelope discipline as every sibling: version gate
 *  first, then a strict field-by-field decode. `granted` is a plain boolean. */
const decodeFidelityMessage = (raw: string): SessionTransportMessage => {
  const envelope = expectObject(JSON.parse(raw) as unknown)
  requireProtocolVersion(envelope)
  const sessionId = decodeString(envelope.sessionId, "bad_transport_session_id")
  if (typeof envelope.granted !== "boolean") {
    throw new SessionProtocolValidationError("bad_transport_fidelity_granted")
  }
  return { kind: "fidelity", sessionId, granted: envelope.granted }
}

const decodeRejectedMessage = (
  raw: string,
  opts: { readonly lenientVersion?: boolean } = {},
): SessionTransportMessage => {
  const envelope = expectObject(JSON.parse(raw) as unknown)
  // S5b — LENIENT mode is the client half of the version-skew handshake:
  // `rejected` frames (and ONLY that kind) may be decoded version-exempt, so a
  // reject stamped with a foreign version still reaches the consumer as a
  // typed rejection instead of being silently dropped. The sessionId is also
  // relaxed to "any string" (a skew-reject echoing the bootstrap-discovery
  // sentinel carries an EMPTY sessionId). Every other field keeps the strict
  // gate — lenient must never admit a structurally different frame.
  if (opts.lenientVersion !== true) requireProtocolVersion(envelope)
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
  const sessionId =
    opts.lenientVersion === true && typeof envelope.sessionId === "string"
      ? envelope.sessionId
      : decodeString(envelope.sessionId, "bad_transport_session_id")
  return {
    kind: "rejected",
    sessionId,
    target,
    reason,
    ...(typeof envelope.commandId === "string" ? { commandId: envelope.commandId } : {}),
    ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    ...(actualRevision !== undefined ? { actualRevision } : {}),
    ...(typeof envelope.issue === "string" ? { issue: envelope.issue } : {}),
  }
}

const decodeHeartbeatMessage = (raw: string): SessionTransportMessage => {
  const envelope = expectObject(JSON.parse(raw) as unknown)
  requireProtocolVersion(envelope)
  const phase = envelope.phase
  if (phase !== "ping" && phase !== "pong") {
    throw new SessionProtocolValidationError("bad_transport_heartbeat_phase")
  }
  return { kind: "heartbeat", phase }
}

/** Encode a `connect` control envelope, folding its four additive opt-ins
 *  (resume cursor / resume-ack / ticket-04 requestedFidelity / surface
 *  subscription). Extracted so `encodeSessionTransportMessage`'s switch stays
 *  under the cognitive-complexity ratchet as additive kinds accrue. */
const encodeConnectEnvelope = (message: SessionTransportConnectMessage): string =>
  encodeControlEnvelope({
    kind: "connect",
    sessionId: message.sessionId,
    ...(message.resumeFromSeq !== undefined ? { resumeFromSeq: message.resumeFromSeq } : {}),
    ...(message.resumeAck === true ? { resumeAck: true } : {}),
    ...(message.requestedFidelity === "full" ? { requestedFidelity: "full" } : {}),
    ...(message.surfaceSubscription !== undefined
      ? { surfaceSubscription: message.surfaceSubscription }
      : {}),
  })

export const encodeSessionTransportMessage = (message: SessionTransportMessage): string => {
  switch (message.kind) {
    case "connect":
      return encodeConnectEnvelope(message)
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
    case "heartbeat":
      return encodeControlEnvelope({ kind: "heartbeat", phase: message.phase })
    case "resumed":
      return encodeControlEnvelope({
        kind: "resumed",
        sessionId: message.sessionId,
        servedThroughSeq: message.servedThroughSeq,
        mode: message.mode,
      })
    case "fidelity":
      return encodeControlEnvelope({
        kind: "fidelity",
        sessionId: message.sessionId,
        granted: message.granted,
      })
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
    case "heartbeat":
      return decodeHeartbeatMessage(raw)
    case "resumed":
      return decodeResumedMessage(raw)
    case "fidelity":
      return decodeFidelityMessage(raw)
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

// ─── S5b (jul-16 ticket 01): version-skew lenient reject ────────────────────
//
// A frame whose `version` fails `isSessionProtocolVersion` used to be dropped
// on the floor by every transport (`tryDecodeSessionTransportMessage` →
// undefined), so version skew degenerated to an unexplained hang on BOTH
// sides. The helpers below implement the two additive halves:
//
//   server half — a skewed CLIENT-INITIATED frame (`connect` / `command`) is
//     answered with a `rejected` reply whose envelope `version` ECHOES the
//     version the peer claimed. Stamping our own version would be
//     self-defeating: the skewed peer's `requireProtocolVersion` gate is
//     exactly what would drop the reply. Reason stays inside the CLOSED-4 set
//     (`protocol_validation`) with issue `"bad_version"` — the only encoding
//     an already-shipped peer's rejected-decoder accepts.
//
//   client half — an inbound `rejected` frame (ONLY that kind) is decoded
//     version-exempt, so the reply above (or a foreign server's own-stamped
//     reject) surfaces as a typed rejection instead of vanishing.
//
// HONEST RESCUE POPULATION: peers shipped BEFORE this change have neither
// half — an old server never sends the reply (new client → old server stays
// silent, the more likely skew once the SDK is public), and an old client can
// only read the reply thanks to the echo + closed-4 reuse AND only when its
// frame carried a non-empty sessionId (the bootstrap discovery sentinel is
// empty ⇒ the old strict decoder refuses the echo; a NEW lenient client reads
// it fine). Typed surfacing exists from this build onward.

interface VersionSkewProbe {
  readonly claimedVersion: string
  readonly kind: "connect" | "command"
  readonly sessionId: string
  readonly commandId?: string
}

const probeSkewedConnect = (
  envelope: Record<string, unknown>,
  claimedVersion: string,
): VersionSkewProbe | undefined =>
  typeof envelope.sessionId === "string"
    ? { claimedVersion, kind: "connect", sessionId: envelope.sessionId }
    : undefined

const probeSkewedCommand = (
  envelope: Record<string, unknown>,
  claimedVersion: string,
): VersionSkewProbe | undefined => {
  const payload = envelope.payload
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined
  const command = payload as Record<string, unknown>
  if (typeof command.sessionId !== "string") return undefined
  return {
    claimedVersion,
    kind: "command",
    sessionId: command.sessionId,
    ...(typeof command.commandId === "string" ? { commandId: command.commandId } : {}),
  }
}

/** Minimal, forgiving read of an UNDECODABLE frame: did the peer claim a
 *  version we do not speak, on a kind we can address a reply to? Only
 *  `connect`/`command` qualify — they are the client-initiated kinds carrying
 *  a sessionId to address the reply with. A frame with NO version field is
 *  garbage, not skew (there is nothing to echo), and stays dropped. */
const probeVersionSkewFrame = (raw: string): VersionSkewProbe | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  const envelope = parsed as Record<string, unknown>
  if (typeof envelope.version !== "string" || isSessionProtocolVersion(envelope.version)) {
    return undefined
  }
  if (envelope.kind === "connect") return probeSkewedConnect(envelope, envelope.version)
  if (envelope.kind === "command") return probeSkewedCommand(envelope, envelope.version)
  return undefined
}

/** Encode the version-skew reject REPLY. Deliberately NOT routed through
 *  `encodeSessionTransportMessage` — that stamps SESSION_PROTOCOL_VERSION,
 *  and the whole point of this frame is the version ECHO (red-on-injection:
 *  swap the echo for our own version and the "old client can decode the
 *  reply" pin in tests/unit/ipc/transport-version-skew.test.ts goes red). */
const encodeVersionSkewRejectedFrame = (probe: VersionSkewProbe): string =>
  JSON.stringify({
    version: probe.claimedVersion,
    kind: "rejected",
    sessionId: probe.sessionId,
    target: probe.kind === "command" ? "command" : "connect",
    reason: "protocol_validation",
    issue: "bad_version",
    ...(probe.commandId !== undefined ? { commandId: probe.commandId } : {}),
  })

export type InboundSessionFrameResolution =
  | { readonly kind: "message"; readonly message: SessionTransportMessage }
  | { readonly kind: "reply"; readonly frame: string }

/**
 * Single inbound-frame gate for the shared transports (stdio + websocket).
 *
 *   valid frame                          → deliver as message (unchanged path)
 *   version-skewed `rejected`            → deliver via the LENIENT decoder
 *   version-skewed `connect`/`command`   → answer with the echo reject reply
 *   anything else undecodable            → drop (unchanged behavior)
 *
 * Loop safety: replies are only ever produced for `connect`/`command` — a
 * `rejected` frame NEVER triggers a reply (no reject ping-pong), and the reply
 * itself is a `rejected` frame.
 */
export const resolveInboundSessionTransportFrame = (
  raw: string,
): InboundSessionFrameResolution | undefined => {
  try {
    return { kind: "message", message: decodeSessionTransportMessage(raw) }
  } catch (error) {
    if (!(error instanceof SessionProtocolValidationError) || error.issue !== "bad_version") {
      return undefined
    }
    let kind: SessionTransportMessage["kind"]
    try {
      kind = decodeKind(raw)
    } catch {
      return undefined
    }
    if (kind === "rejected") {
      try {
        return {
          kind: "message",
          message: decodeRejectedMessage(raw, { lenientVersion: true }),
        }
      } catch {
        return undefined
      }
    }
    const probe = probeVersionSkewFrame(raw)
    if (probe === undefined) return undefined
    return { kind: "reply", frame: encodeVersionSkewRejectedFrame(probe) }
  }
}
