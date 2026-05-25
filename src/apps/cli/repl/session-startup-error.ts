export type SessionStartupFailureKind =
  | "llm_build_failed"
  | "image_load_failed"
  | "resume_conflict"
  | "resume_missing_id"
  | "session_cwd_missing"

export class SessionStartupError extends Error {
  readonly kind: SessionStartupFailureKind
  readonly exitCode = 1

  override readonly cause: unknown

  constructor(kind: SessionStartupFailureKind, message: string, cause?: unknown) {
    super(message)
    this.name = "SessionStartupError"
    this.kind = kind
    this.cause = cause
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export const isSessionStartupError = (value: unknown): value is SessionStartupError =>
  value instanceof SessionStartupError

export const failSessionStartup = (
  kind: SessionStartupFailureKind,
  message: string,
  cause?: unknown,
): never => {
  throw new SessionStartupError(kind, message, cause)
}
