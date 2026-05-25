/**
 * Typed error enum (ADR-0203) — Codex 16-variant absorption.
 *
 * Plane-clean: imports only `@/shared` for sibling types. No `@/llm`,
 * no `@/tool`, no `@/permission` — this is the LEAF that they all key off,
 * so it cannot import any of them without inversion. The default classifier
 * (`./default-classifier.ts`) is the layer that READS `LLMError.kind` /
 * `PermissionDeniedError` and produces values of these types.
 *
 * Adding a new arm to `TypedErrorKind` forces:
 *   1. update to `ALL_TYPED_ERROR_KINDS` (compile-time tuple cross-check),
 *   2. update to the default router's switch (`assertNever` guard),
 *   3. update to every wired consumer's switch (compile error).
 */

/**
 * 16-arm CLOSED union — Codex verbatim (build 2867, `.extracted_source/codex`).
 *
 *   contextWindowExceeded   — input + history exceeds provider's max tokens.
 *                              Reactive compaction can recover same-turn.
 *   usageLimitExceeded      — account-level quota exhausted. Fatal.
 *   cyberPolicy             — request blocked by safety / content policy.
 *                              Needs human-in-the-loop.
 *   httpConnectionFailed    — transport never reached the server (DNS,
 *                              ECONNRESET, ETIMEDOUT). Retry with backoff.
 *   httpStatusCode          — server returned a status. Branch on `status`:
 *                              429 → backoff, 5xx → fallback, other → backoff.
 *   responseStreamConnectionFailed — SSE/stream handshake failed before
 *                                     any data. Retry with backoff.
 *   responseStreamDisconnected     — stream cut mid-flight. Retry with backoff.
 *   responseTooManyFailedAttempts  — caller has retried past the cap. Abort.
 *   internalServerError     — last-resort bucket (5xx not otherwise classified,
 *                              unknown thrown values). Routes to swap-fallback.
 *   unauthorized            — auth missing/invalid (HTTP 401/403). Fatal.
 *   badRequest              — caller bug (HTTP 400/422). Abort.
 *   threadRollbackFailed    — conversation-checkpoint restore failed. Retry
 *                              same-turn (try a different checkpoint).
 *   sandboxError            — OS sandbox denied an action. Needs HITL.
 *   activeTurnNotSteerable  — mid-turn steer attempted but the turn is in a
 *                              non-steerable state (compacting, awaiting tool
 *                              result, abort signaled). HITL.
 *   unifiedExecStartup      — shell wrapper failed to launch the subprocess
 *                              (binary missing, jail rejection at spawn time).
 *                              Retry with backoff (re-exec).
 *   unifiedExecInteraction  — shell wrapper succeeded to launch but stdin/
 *                              stdout interaction failed mid-stream. Retry
 *                              with backoff.
 */
export type TypedErrorKind =
  | "contextWindowExceeded"
  | "usageLimitExceeded"
  | "cyberPolicy"
  | "httpConnectionFailed"
  | "httpStatusCode"
  | "responseStreamConnectionFailed"
  | "responseStreamDisconnected"
  | "responseTooManyFailedAttempts"
  | "internalServerError"
  | "unauthorized"
  | "badRequest"
  | "threadRollbackFailed"
  | "sandboxError"
  | "activeTurnNotSteerable"
  | "unifiedExecStartup"
  | "unifiedExecInteraction"

/** Canonical literal tuple — runtime guard that the type does not silently
 *  drift from the consumer switch. Tested by HELL-ER-24. */
export const ALL_TYPED_ERROR_KINDS = [
  "contextWindowExceeded",
  "usageLimitExceeded",
  "cyberPolicy",
  "httpConnectionFailed",
  "httpStatusCode",
  "responseStreamConnectionFailed",
  "responseStreamDisconnected",
  "responseTooManyFailedAttempts",
  "internalServerError",
  "unauthorized",
  "badRequest",
  "threadRollbackFailed",
  "sandboxError",
  "activeTurnNotSteerable",
  "unifiedExecStartup",
  "unifiedExecInteraction",
] as const satisfies ReadonlyArray<TypedErrorKind>

/**
 * Discriminated typed-error union. Each arm carries the same
 * `message: string` for the human-readable surface, plus arm-specific
 * payload where present.
 *
 * `exactOptionalPropertyTypes`: NO optional fields — every payload key is
 * required on the arm that declares it. Boundary translators conditional-
 * spread; the shape never has `key: undefined`.
 */
export type TypedError =
  | { readonly kind: "contextWindowExceeded"; readonly message: string }
  | { readonly kind: "usageLimitExceeded"; readonly message: string }
  | { readonly kind: "cyberPolicy"; readonly message: string }
  | { readonly kind: "httpConnectionFailed"; readonly message: string }
  | {
      readonly kind: "httpStatusCode"
      readonly message: string
      /** HTTP status. 429 → backoff, 5xx → fallback, other → backoff. */
      readonly status: number
    }
  | { readonly kind: "responseStreamConnectionFailed"; readonly message: string }
  | { readonly kind: "responseStreamDisconnected"; readonly message: string }
  | { readonly kind: "responseTooManyFailedAttempts"; readonly message: string }
  | { readonly kind: "internalServerError"; readonly message: string }
  | { readonly kind: "unauthorized"; readonly message: string }
  | { readonly kind: "badRequest"; readonly message: string }
  | { readonly kind: "threadRollbackFailed"; readonly message: string }
  | { readonly kind: "sandboxError"; readonly message: string }
  | { readonly kind: "activeTurnNotSteerable"; readonly message: string }
  | { readonly kind: "unifiedExecStartup"; readonly message: string }
  | { readonly kind: "unifiedExecInteraction"; readonly message: string }

/**
 * Routing decision the loop applies after `classify(e)`. CLOSED 5-arm
 * union — adding an action forces a compile error at every router
 * consumer's switch.
 *
 *   retry-same-turn     reactive compaction / checkpoint swap (context window,
 *                       thread rollback). Stay on the same provider.
 *   retry-with-backoff  transport / stream / 429 / re-exec. Same provider,
 *                       exponential backoff.
 *   swap-fallback       5xx / internal server. Switch to next provider in
 *                       the fallback chain.
 *   hitl                policy / sandbox / steer-denied. Surface to a human;
 *                       loop pauses.
 *   abort               usage limit / unauthorized / repeated failures /
 *                       bad request. Terminate the turn; no retry.
 */
export type RetryAction =
  | "retry-same-turn"
  | "retry-with-backoff"
  | "swap-fallback"
  | "hitl"
  | "abort"

/** Canonical literal tuple — runtime guard for `RetryAction`. */
export const ALL_RETRY_ACTIONS = [
  "retry-same-turn",
  "retry-with-backoff",
  "swap-fallback",
  "hitl",
  "abort",
] as const satisfies ReadonlyArray<RetryAction>
