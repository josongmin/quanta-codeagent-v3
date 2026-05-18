/** Base error carrying a stable machine-readable code. */
export class QuantaError extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = new.target.name
    this.code = code
  }
}

/** Tool failed during execution (input was valid, runtime failed). */
export class ToolExecutionError extends QuantaError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("tool_execution", message, options)
  }
}

/** Tool input failed schema validation. */
export class ToolInputError extends QuantaError {
  constructor(message: string) {
    super("tool_input", message)
  }
}

/** Action blocked by the permission policy. */
export class PermissionDeniedError extends QuantaError {
  constructor(message: string) {
    super("permission_denied", message)
  }
}

/** LLM provider failed (network, auth, rate limit, malformed response). */
export class LLMError extends QuantaError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("llm", message, options)
  }
}

export const toError = (e: unknown): Error =>
  e instanceof Error ? e : new Error(typeof e === "string" ? e : JSON.stringify(e))
