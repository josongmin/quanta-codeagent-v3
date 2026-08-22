/**
 * Default `RetryRouter` (ADR-0217). Single pure switch over `TypedError.kind`
 * implementing the Codex-verbatim routing table:
 *
 *   contextWindowExceeded | threadRollbackFailed              → retry-same-turn
 *   httpStatusCode(429) | httpConnectionFailed
 *     | responseStreamConnectionFailed
 *     | responseStreamDisconnected
 *     | unifiedExecStartup | unifiedExecInteraction           → retry-with-backoff
 *   httpStatusCode(5xx) | internalServerError                 → swap-fallback
 *   cyberPolicy | sandboxError | activeTurnNotSteerable       → hitl
 *   usageLimitExceeded | unauthorized
 *     | responseTooManyFailedAttempts | badRequest            → abort
 *
 * The ONLY arm with a payload-dependent branch is `httpStatusCode`. All other
 * arms map 1:1 to an action.
 *
 * Plane-clean leaf: imports only `./port`, `./types`, and `@/shared`'s
 * `assertNever` guard.
 */

import { assertNever } from "@/shared"
import type { RetryRouter } from "./port"
import type { RetryAction, TypedError } from "./types"

const decideHttpStatus = (status: number): RetryAction => {
  // 429 is a special case: rate limit → backoff (NOT fallback). Locked by HELL-ER-25.
  if (status === 429) return "retry-with-backoff"
  // 5xx → fallback (provider-level outage; another provider may be healthy).
  if (status >= 500 && status < 600) return "swap-fallback"
  // Everything else (4xx other than 429, redirects, anything else with a status)
  // → backoff. 401/403/400/422 reach us as `unauthorized`/`badRequest` arms
  // BEFORE this branch (classifier maps them up); a stray non-429 4xx here is
  // most likely a transient route issue, so a single backoff retry is safer
  // than immediate abort.
  return "retry-with-backoff"
}

const decideInner = (e: TypedError): RetryAction => {
  switch (e.kind) {
    case "contextWindowExceeded":
      return "retry-same-turn"
    case "threadRollbackFailed":
      return "retry-same-turn"

    case "httpStatusCode":
      return decideHttpStatus(e.status)
    case "httpConnectionFailed":
      return "retry-with-backoff"
    case "responseStreamConnectionFailed":
      return "retry-with-backoff"
    case "responseStreamDisconnected":
      return "retry-with-backoff"
    case "unifiedExecStartup":
      return "retry-with-backoff"
    case "unifiedExecInteraction":
      return "retry-with-backoff"

    case "internalServerError":
      return "swap-fallback"

    case "cyberPolicy":
      return "hitl"
    case "sandboxError":
      return "hitl"
    case "activeTurnNotSteerable":
      return "hitl"

    case "usageLimitExceeded":
      return "abort"
    case "unauthorized":
      return "abort"
    case "responseTooManyFailedAttempts":
      return "abort"
    case "badRequest":
      return "abort"

    default:
      return assertNever(e, "TypedError.kind")
  }
}

export const defaultRetryRouter: RetryRouter = {
  decide: decideInner,
}
