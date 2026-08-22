export class SessionProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SessionProtocolError"
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export class SessionProtocolValidationError extends SessionProtocolError {
  constructor(
    readonly issue: string,
    message = `session protocol validation failed: ${issue}`,
  ) {
    super(message)
    this.name = "SessionProtocolValidationError"
  }
}

export class SessionRevisionConflictError extends SessionProtocolError {
  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(`expected revision ${expectedRevision}, got ${actualRevision}`)
    this.name = "SessionRevisionConflictError"
  }
}

export class SessionClosedError extends SessionProtocolError {
  constructor(readonly sessionId: string) {
    super(`session ${sessionId} is closed`)
    this.name = "SessionClosedError"
  }
}

/**
 * S5b (jul-16 ticket 01) — a peer rejected our frame over a protocol VERSION
 * mismatch (`rejected` with reason `protocol_validation` + issue
 * `"bad_version"`). The reply frame the server sends ECHOES the version WE
 * claimed (so our own version gate can read it) — it does not reveal which
 * version the peer runs, hence only `localVersion` (ours) is carried here.
 *
 * Honest rescue population: peers shipped BEFORE the lenient-reject change
 * never send this reply at all (old server → any client stays silent) — this
 * typed error can only surface against servers carrying S5b.
 */
export class SessionProtocolVersionError extends SessionProtocolError {
  constructor(
    /** The protocol version THIS build speaks (the one the peer refused). */
    readonly localVersion: string,
    /** The rejected command, when the refused frame was a command. */
    readonly commandId?: string,
  ) {
    super(
      commandId === undefined
        ? `session protocol version ${localVersion} was rejected by the peer`
        : `session protocol version ${localVersion} was rejected by the peer (command ${commandId})`,
    )
    this.name = "SessionProtocolVersionError"
  }
}
