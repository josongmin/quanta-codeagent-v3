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

/**
 * RFC-05 E4 — a `session.posture.set` (or its `session.permission.set`
 * compatibility adapter) could NOT be applied because the host wired NO posture
 * projection method. A TYPED NEGATIVE — the command must never report success
 * through an absent optional host method (RFC-05 E4 RED (b) / hard rule).
 */
export class SessionPostureUnsupportedError extends SessionProtocolError {
  constructor() {
    super("session posture command is unsupported: host wired no setPosture projection")
    this.name = "SessionPostureUnsupportedError"
  }
}

/**
 * RFC-05 E4 — a `session.posture.set` was rejected by the host authority because
 * its `expectedPostureRevision` no longer matches the live POSTURE-domain
 * revision (a stale multi-surface edit). A typed CONFLICT — the winner's commit
 * is never clobbered.
 */
export class SessionPostureConflictError extends SessionProtocolError {
  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(`stale posture revision: expected ${expectedRevision}, got ${actualRevision}`)
    this.name = "SessionPostureConflictError"
  }
}

/**
 * RFC-05 E4 — a `session.posture.set` could not durably persist (the authority's
 * persist-before-publish barrier refused to publish). A typed negative — the old
 * posture stays live, never a published-but-unpersisted mutation.
 */
export class SessionPosturePersistError extends SessionProtocolError {
  constructor(readonly detail: string) {
    super(`posture mutation failed to persist: ${detail}`)
    this.name = "SessionPosturePersistError"
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
