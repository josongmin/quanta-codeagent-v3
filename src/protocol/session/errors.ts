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
