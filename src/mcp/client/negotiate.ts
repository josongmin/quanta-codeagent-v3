import {
  isSupportedProtocolVersion,
  PROTOCOL_DOWNGRADE_FLOOR,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "../protocol-version"
import type { McpTransport } from "../transports/port"
import { McpError, VERSION_REJECTION_CODES } from "./errors"
import { asRecord } from "./result-folding"

/** Ticket misc-jun-7/01 — issue `initialize` offering `offeredVersion`; on a
 *  rejection from a STRICT server (a JSON-RPC error rather than a negotiated-down
 *  reply) AND only when the offer was newer than the floor, retry exactly ONCE at
 *  the floor ({@link PROTOCOL_DOWNGRADE_FLOOR}). The re-offer is bounded — a
 *  second failure (or a non-McpError, or an offer that was already the floor)
 *  propagates, never looping. The §5 worst case is one extra round-trip, then
 *  byte-identical.
 *
 *  Returns BOTH the raw result AND the version that ultimately succeeded on the
 *  wire, so the legacy-tolerant pin (server omits `protocolVersion`) uses the
 *  offer that actually connected — not the pre-downgrade offer.
 *
 *  The downgrade is offer-side only: a spec-compliant server that negotiates DOWN
 *  (returns the floor in a SUCCESSFUL reply) never enters the catch — it is
 *  handled by {@link pinNegotiatedVersion}'s accept branch.
 *
 *  `sendInitialize` is injected so the correlated `request`/timeout/pending core
 *  + capability compilation stay owned by the client. */
export const initializeWithDowngrade = async (
  offeredVersion: string,
  transport: McpTransport,
  sendInitialize: (version: string) => Promise<unknown>,
): Promise<{ result: unknown; offered: string }> => {
  const offer = offeredVersion
  try {
    return { result: await sendInitialize(offer), offered: offer }
  } catch (err) {
    // Ticket misc-jun-7/01 R2 — re-offer ONLY when (a) the offered version was
    // newer than the floor (so the floor is a real downgrade) AND (b) the
    // failure is a genuine VERSION-REJECTION: a server JSON-RPC `error` whose
    // code is in {@link VERSION_REJECTION_CODES} (-32602 / -32600), the §4.c
    // canonical strict-reject shape.
    //
    // It must NOT fire on any other McpError. A request TIMEOUT, a
    // connection-level transport failure, or a transient server fault
    // (`InternalError -32603`, an app-defined `-32000` transport synth) carries
    // NO version-rejection code — re-offering the floor on those would (1)
    // waste a round-trip and (2) WORSE, silently pin the OLDER protocol if the
    // floor then succeeds, masking a transient fault as a permanent version
    // incompatibility (a capability loss). Those propagate untouched.
    const isVersionRejection =
      err instanceof McpError &&
      err.jsonRpcCode !== undefined &&
      VERSION_REJECTION_CODES.has(err.jsonRpcCode)
    if (offer === PROTOCOL_DOWNGRADE_FLOOR || !isVersionRejection) throw err
    // Re-pin the transport header to the floor for the re-offer POST so the
    // header and body agree on the retry.
    transport.setProtocolVersion?.(PROTOCOL_DOWNGRADE_FLOOR)
    const result = await sendInitialize(PROTOCOL_DOWNGRADE_FLOOR)
    return { result, offered: PROTOCOL_DOWNGRADE_FLOOR }
  }
}

/** Ticket misc-jun-7/01 — read the server's chosen `protocolVersion` from the
 *  `initialize` reply and decide:
 *   - ABSENT (legacy-tolerant) ⇒ pin the OFFERED version that connected (today's
 *     behavior, no regression). A malformed/non-string slot is treated as absent
 *     — routed around, never thrown on (§4.e).
 *   - IN the supported set ⇒ accept + pin it (this is what the HTTP header then
 *     carries on every subsequent request).
 *   - PRESENT but NOT in the set ⇒ fail closed with a typed `McpError` (Codex
 *     `UNSUPPORTED_PROTOCOL` parity). We never proceed on a version we do not
 *     implement. This is a PROTOCOL error ⇒ a throw, NOT an `isError` result.
 *
 *  Returns the version that was pinned (the caller stores it as the session's
 *  negotiated version); the transport header is pinned as a side effect. */
export const pinNegotiatedVersion = (
  initResult: unknown,
  offered: string,
  transport: McpTransport,
  serverName: string,
): string => {
  const replied = asRecord(initResult)?.protocolVersion
  if (typeof replied !== "string") {
    // Absent or malformed → legacy-tolerant: pin the offer that connected.
    transport.setProtocolVersion?.(offered)
    return offered
  }
  if (!isSupportedProtocolVersion(replied)) {
    throw new McpError(
      `mcp server "${serverName}" replied with unsupported protocolVersion "${replied}"; supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}`,
    )
  }
  transport.setProtocolVersion?.(replied)
  return replied
}
