import {
  SESSION_PROTOCOL_VERSION,
  SessionProtocolError,
  SessionProtocolValidationError,
  SessionProtocolVersionError,
  SessionRevisionConflictError,
} from "@/protocol/session"
import type { SessionTransportRejectedMessage } from "./types"

export class SessionDuplicateCommandError extends SessionProtocolError {
  constructor(readonly commandId: string) {
    super(`duplicate commandId ${commandId}`)
    this.name = "SessionDuplicateCommandError"
  }
}

/**
 * S5a (jul-16 ticket 01) — a command PASSED the bridge's admission checks
 * (session id / dedup / revision) but FAILED at dispatch stage (kernel reducer
 * or host threw) with an error that carries no protocol-validation issue of
 * its own. On the wire it rides the EXISTING `protocol_validation` reason with
 * the stable issue `"dispatch_failed"` (S0-3 ruling: reusing the closed-4
 * reason set is the only encoding an already-shipped peer can decode).
 *
 * Server side: constructed by the bridge with the original error as `cause`.
 * Client side: reconstructed from a rejected frame (no cause available).
 */
export class SessionDispatchFailedError extends SessionProtocolError {
  /** Stable wire `issue` string (see `toRejectedMessage`, bridge.ts). */
  readonly issue = "dispatch_failed"
  readonly commandId?: string
  constructor(opts: { readonly commandId?: string; readonly cause?: unknown } = {}) {
    super(
      opts.commandId === undefined
        ? "session command dispatch failed"
        : `session command dispatch failed (command ${opts.commandId})`,
    )
    this.name = "SessionDispatchFailedError"
    if (opts.commandId !== undefined) this.commandId = opts.commandId
    if (opts.cause !== undefined) this.cause = opts.cause
  }
}

/**
 * S5 (jul-16 ticket 01) — map a wire `rejected` frame onto the typed error a
 * consumer can branch on. This is the client-side SSOT for ALL rejected
 * reasons (the "rejected 5종" of the ticket):
 *
 *   duplicate_command                      → SessionDuplicateCommandError
 *   revision_conflict                      → SessionRevisionConflictError
 *   session_id_mismatch                    → SessionProtocolValidationError
 *   protocol_validation + "bad_version"    → SessionProtocolVersionError (S5b)
 *   protocol_validation + "dispatch_failed"→ SessionDispatchFailedError  (S5a)
 *   protocol_validation + <kernel issue>   → SessionProtocolValidationError
 *
 * Frames minted by our own bridge always carry the optional fields the typed
 * constructors want; a foreign/hand-rolled frame that omits them degrades to
 * documented placeholders (`"<unknown>"` commandId, `-1` revisions) instead of
 * being dropped — the typed CLASS is the contract, not those fillers.
 */
export const typedErrorFromRejectedMessage = (
  message: SessionTransportRejectedMessage,
): SessionProtocolError => {
  switch (message.reason) {
    case "duplicate_command":
      return new SessionDuplicateCommandError(message.commandId ?? "<unknown>")
    case "revision_conflict":
      return new SessionRevisionConflictError(
        message.expectedRevision ?? -1,
        message.actualRevision ?? -1,
      )
    case "session_id_mismatch":
      return new SessionProtocolValidationError("session_id_mismatch")
    case "protocol_validation": {
      if (message.issue === "bad_version") {
        return new SessionProtocolVersionError(SESSION_PROTOCOL_VERSION, message.commandId)
      }
      if (message.issue === "dispatch_failed") {
        return new SessionDispatchFailedError(
          message.commandId !== undefined ? { commandId: message.commandId } : {},
        )
      }
      return new SessionProtocolValidationError(message.issue ?? "protocol_validation")
    }
  }
}
