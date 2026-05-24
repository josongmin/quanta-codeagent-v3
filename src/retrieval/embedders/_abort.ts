const ABORT_ERROR_NAME = "AbortError"
const TIMEOUT_ERROR_NAME = "TimeoutError"

export const isAbortError = (err: unknown): boolean => {
  if (typeof err !== "object" || err === null) return false
  const name = (err as { name?: unknown }).name
  return name === ABORT_ERROR_NAME || name === TIMEOUT_ERROR_NAME
}

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
