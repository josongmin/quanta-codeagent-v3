const ABORT_ERROR_NAME = "AbortError"
const TIMEOUT_ERROR_NAME = "TimeoutError"

export const isAbortError = (err: unknown): boolean => {
  if (typeof err !== "object" || err === null) return false
  const name = (err as { name?: unknown }).name
  return name === ABORT_ERROR_NAME || name === TIMEOUT_ERROR_NAME
}
