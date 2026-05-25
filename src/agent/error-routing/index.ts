/**
 * Error-routing slice barrel (ADR-0217). Plane-clean leaf — Codex 16-variant
 * typed error enum + 5-action retry router.
 *
 * Nobody imports this slice today (default-OFF). Wiring into the loop /
 * fallback / retry is a follow-up.
 */

export { defaultErrorClassifier } from "./default-classifier"
export { defaultRetryRouter } from "./default-router"
export type { ErrorClassifier, RetryRouter } from "./port"
export type { RetryAction, TypedError, TypedErrorKind } from "./types"
export { ALL_RETRY_ACTIONS, ALL_TYPED_ERROR_KINDS } from "./types"
