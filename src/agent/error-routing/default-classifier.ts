/**
 * Default `ErrorClassifier` (ADR-0217). Pure boundary translator from
 * an arbitrary thrown value to the 16-arm `TypedError` discriminant.
 *
 * Source priority (first match wins):
 *   1. `LLMError` — already classified at the LLM boundary (ADR-0069
 *      sibling 11-arm `LLMErrorKind`). Map onto the 16-arm enum.
 *   2. `PermissionDeniedError` → `cyberPolicy`.
 *   3. `ToolExecutionError` → `internalServerError` (unknown tool surface).
 *   4. AbortError / TimeoutError name → `activeTurnNotSteerable`.
 *   5. Node transport `code` (ECONNRESET, ETIMEDOUT, etc.) → `httpConnectionFailed`.
 *   6. Anything else (unknown SDK error, plain object, primitive, null,
 *      undefined) → `internalServerError` (degrade to swap-fallback).
 *
 * MUST be PURE — no I/O, no logging, no global state. Locked by HELL-ER-23.
 *
 * Plane-clean: imports only `@/shared` (LLMError, the sibling error
 * classes, errMessage). The new typed-error slice is the LEAF that other
 * slices key off, so it cannot import `@/llm` / `@/tool` / `@/permission`.
 */

import {
  errMessage,
  LLMError,
  type LLMErrorKind,
  PermissionDeniedError,
  ToolExecutionError,
} from "@/shared"
import type { ErrorClassifier } from "./port"
import type { TypedError } from "./types"

// Mirror of `@/shared/errors`' private NETWORK_CODES. Duplicated here (3 lines)
// to keep the slice plane-clean (`@/shared/errors` doesn't export it). If a
// new Node transport code lands in `@/shared/errors`, mirror it here.
const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
])

const isAbortName = (e: unknown): boolean => {
  if (typeof e !== "object" || e === null) return false
  const name = (e as { name?: unknown }).name
  return name === "AbortError" || name === "TimeoutError"
}

const transportCode = (e: unknown): string | undefined => {
  if (typeof e !== "object" || e === null) return undefined
  const code = (e as { code?: unknown }).code
  return typeof code === "string" ? code : undefined
}

/** Map an LLMError to the 16-arm enum. Pure function; total on
 *  `LLMErrorKind` (all 11 arms covered). The status-bearing arms
 *  (`overloaded`/`rate_limit`/`server_error`/`not_found`) reuse the
 *  status from `LLMError.statusCode` when present (preferred) or a
 *  canonical fallback. */
const fromLLMError = (e: LLMError): TypedError => {
  const message = e.message
  const kind: LLMErrorKind = e.kind
  switch (kind) {
    case "overloaded":
      return { kind: "httpStatusCode", message, status: e.statusCode ?? 529 }
    case "rate_limit":
      return { kind: "httpStatusCode", message, status: e.statusCode ?? 429 }
    case "server_error":
      return e.statusCode !== undefined
        ? { kind: "httpStatusCode", message, status: e.statusCode }
        : { kind: "internalServerError", message }
    case "network":
      return { kind: "httpConnectionFailed", message }
    case "auth":
      return { kind: "unauthorized", message }
    case "bad_request":
      return { kind: "badRequest", message }
    case "not_found":
      return { kind: "httpStatusCode", message, status: e.statusCode ?? 404 }
    case "not_implemented":
      // Codex has no direct equivalent — `badRequest` is the closest
      // "abort, do not retry same provider" semantic. The LLM-fallback
      // layer already swaps providers on `not_implemented` (ADR-0094);
      // the typed-error layer's `abort` is the consistent next step
      // after fallback exhausts.
      return { kind: "badRequest", message }
    case "stream_corrupt":
      return { kind: "responseStreamDisconnected", message }
    case "aborted":
      return { kind: "activeTurnNotSteerable", message }
    case "unknown":
      return { kind: "internalServerError", message }
    // ADR-0214 Codex-spec absorption — 5 new `LLMErrorKind` arms map
    // verbatim onto their `TypedErrorKind` counterparts (camelCase).
    case "context_window_exceeded":
      return { kind: "contextWindowExceeded", message }
    case "cyber_policy":
      return { kind: "cyberPolicy", message }
    case "too_many_failed_attempts":
      return { kind: "responseTooManyFailedAttempts", message }
    case "thread_rollback_failed":
      return { kind: "threadRollbackFailed", message }
    case "sandbox_error":
      return { kind: "sandboxError", message }
    case "invalid_image":
      // ADR-0328 — `invalid_image` is recovered by the
      // `withImageSanitizationRetry` LLM wrap (ADR-0323 sanitization +
      // re-stream). If the wrap exhausted and the error escaped to the
      // typed-error router, the only consistent outer policy is
      // `badRequest` (same as a non-image 400 — sanitize-retry already
      // had its shot, further retry would just re-poison the history).
      return { kind: "badRequest", message }
    default: {
      // Exhaustiveness guard: if a new `LLMErrorKind` is added in
      // `@/shared/errors`, TS fails here.
      const _x: never = kind
      void _x
      return { kind: "internalServerError", message }
    }
  }
}

const classifyInner = (e: unknown): TypedError => {
  // 1. LLMError — already classified upstream.
  if (e instanceof LLMError) return fromLLMError(e)

  // 2. PermissionDeniedError → safety/policy block.
  if (e instanceof PermissionDeniedError) {
    return { kind: "cyberPolicy", message: e.message }
  }

  // 3. ToolExecutionError → unknown tool surface (router → swap-fallback).
  //    Tool slice has its own typed `ToolFailure` (ADR-0069); this branch
  //    catches the throw-shaped escape hatch only.
  if (e instanceof ToolExecutionError) {
    return { kind: "internalServerError", message: e.message }
  }

  // 4. AbortError / TimeoutError → mid-turn cancellation surface.
  if (isAbortName(e)) {
    return { kind: "activeTurnNotSteerable", message: errMessage(e) }
  }

  // 5. Node transport code.
  const code = transportCode(e)
  if (code !== undefined && NETWORK_CODES.has(code)) {
    return { kind: "httpConnectionFailed", message: errMessage(e) }
  }

  // 6. Unknown — degrade to internalServerError (router → swap-fallback).
  //    This includes plain Error, plain object, string, number, null,
  //    undefined. The router will try one more provider before aborting,
  //    which is the safest default for a never-classified shape.
  return { kind: "internalServerError", message: errMessage(e) }
}

export const defaultErrorClassifier: ErrorClassifier = {
  classify: classifyInner,
}
