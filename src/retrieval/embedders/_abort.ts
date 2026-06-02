const ABORT_ERROR_NAME = "AbortError"
const TIMEOUT_ERROR_NAME = "TimeoutError"

export const isAbortError = (err: unknown): boolean => {
  if (typeof err !== "object" || err === null) return false
  const name = (err as { name?: unknown }).name
  return name === ABORT_ERROR_NAME || name === TIMEOUT_ERROR_NAME
}

/**
 * Wrap-message helper for vendor embed() failures.
 *
 * Vendor SDKs sometimes `throw` a raw value (string / object) instead of an
 * `Error`. Interpolating that raw value into the wrapper message — e.g. via
 * `String(e)` — leaks whatever the vendor put there (auth strings, signed
 * URLs, request bodies). We only surface `.message` for genuine `Error`
 * instances; for any non-Error throw we emit a generic label and leave the
 * raw value attached to the wrapper's `cause` (not its `.message`) so
 * forensics still has it without exposing it in user-visible text.
 */
export const safeVendorErrMessage = (e: unknown): string =>
  e instanceof Error ? e.message : "vendor threw a non-Error value"

export const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (!signal?.aborted) return
  const reason = signal.reason
  if (reason instanceof Error) throw reason
  const err = new Error(
    typeof reason === "string" && reason.length > 0 ? reason : "The operation was aborted.",
  )
  err.name = ABORT_ERROR_NAME
  throw err
}
