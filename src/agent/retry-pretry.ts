/**
 * `withRetryPRetry` — a `p-retry@8`-backed promise-retry primitive sitting
 * SIBLING-style next to `retry.ts` (which decorates a streaming `LLMPort`).
 *
 * Why a NEW promise-shaped API rather than swapping the existing class:
 *   `RetryingLLM` retries an `AsyncIterable<StreamEvent>` with a "once ≥1
 *   event has been yielded, NEVER restart" guard (transcript safety). p-retry
 *   models `() => Promise<T>` — it cannot express that mid-stream yielded
 *   invariant. So the streaming class stays untouched (see negative
 *   invariants in ADR-0192) and we add a fresh promise-shaped helper for
 *   one-shot retryable operations (LLM oneshot calls, tool invocations,
 *   network probes, etc.) that DON'T have a "partial output already
 *   consumed" hazard.
 *
 * Classification piggy-backs on the SAME `isRetryable` already exported by
 * `retry.ts` so the LLM-error vocabulary (markers + kinds + PTL precedence)
 * is byte-identical to the streaming decorator's. AbortSignal is forwarded
 * to p-retry verbatim.
 *
 * Defaults match `retry.ts`:
 *   - maxAttempts = 4 + 1 (factor 2, [0, 15s] full-jitter ceiling)
 *   - initialDelayMs = 500
 *   - jitter = true
 */

import pRetry, { AbortError } from "p-retry"
import { isRetryable } from "./retry"

/** Result of a single `onAttempt` notification — fired BEFORE p-retry sleeps. */
export interface RetryAttemptInfo {
  /** 1-based attempt index of the call that just FAILED. */
  readonly attempt: number
  /** The error that caused the failure. */
  readonly error: Error
  /** Attempts remaining AFTER this failure. `0` ⇒ this was the last one. */
  readonly retriesLeft: number
}

/** Caller-visible retry options. Mirrors what a typical `withRetry(...)`
 *  primitive would expose; the p-retry-specific `factor` is added as an
 *  optional escape hatch. */
export interface RetryOpts {
  /** Total attempts (the first call + retries). Defaults to 5 (= 1 + 4). */
  readonly maxAttempts?: number
  /** Backoff start, in ms. Defaults to 500. */
  readonly initialDelayMs?: number
  /** Backoff ceiling, in ms. Defaults to 15_000. */
  readonly maxDelayMs?: number
  /** Whether to multiply each delay by `[1, 2)`. Defaults to `true`. */
  readonly jitter?: boolean
  /**
   * Custom retryability predicate. When omitted, the same `isRetryable`
   * vocabulary used by `RetryingLLM` (LLMError-aware) applies. Non-retryable
   * errors are wrapped in `AbortError` so p-retry stops immediately.
   */
  readonly retryableMarkers?: (e: unknown) => boolean
  /** Forwarded to p-retry. Honored both during sleep and between attempts. */
  readonly signal?: AbortSignal
  /** Called once per failed attempt (NOT the success path). */
  readonly onAttempt?: (info: RetryAttemptInfo) => void
}

/** p-retry-specific extension: the exponential factor (default 2). */
export interface PRetryOpts extends RetryOpts {
  readonly factor?: number
}

/** Discriminated retry outcome. We do NOT throw on exhaustion — callers get a
 *  typed `failed` envelope. Mirrors a common `Result<T, E>` shape. */
export type RetryResult<T> =
  | { readonly kind: "ok"; readonly value: T; readonly attempts: number }
  | { readonly kind: "failed"; readonly error: Error; readonly attempts: number }

const DEFAULT_MAX_ATTEMPTS = 5
const DEFAULT_INITIAL_DELAY_MS = 500
const DEFAULT_MAX_DELAY_MS = 15_000

const toError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)))

/**
 * p-retry-backed wrapper. Calls `fn` up to `opts.maxAttempts` times with
 * exponential backoff + optional full-jitter. Non-retryable errors short-
 * circuit via `AbortError`. AbortSignal cancels both pending sleeps and
 * future attempts.
 *
 * NEVER throws — failures are returned as `{kind:"failed", ...}` envelopes,
 * including signal-driven cancellation.
 */
export const withRetryPRetry = async <T>(
  fn: () => Promise<T>,
  opts: PRetryOpts = {},
): Promise<RetryResult<T>> => {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const initialDelayMs = opts.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
  const jitter = opts.jitter ?? true
  const factor = opts.factor ?? 2
  const classify = opts.retryableMarkers ?? isRetryable

  // Track the highest attempt seen so the `failed` envelope's `attempts`
  // count is accurate even after AbortError short-circuit (p-retry does not
  // surface attempt count on the rejection, only via `onFailedAttempt`).
  let attempts = 0
  let lastError: Error | undefined

  // Caller cannot pass an already-aborted signal to p-retry@8 — it would
  // race with the first call. Honor it explicitly up front so the envelope
  // reads `attempts: 0` (no fn invocation occurred).
  if (opts.signal?.aborted) {
    const reason = opts.signal.reason
    return {
      kind: "failed",
      error:
        reason instanceof Error
          ? reason
          : new Error(typeof reason === "string" ? reason : "aborted"),
      attempts: 0,
    }
  }

  try {
    const value = await pRetry<T>(
      async (attemptNumber: number) => {
        attempts = attemptNumber
        try {
          return await fn()
        } catch (raw) {
          const err = toError(raw)
          lastError = err
          if (!classify(err)) {
            // Force p-retry to stop immediately. p-retry unwraps AbortError
            // and rejects with `err` directly, preserving the original.
            throw new AbortError(err)
          }
          throw err
        }
      },
      {
        retries: Math.max(0, maxAttempts - 1),
        factor,
        minTimeout: initialDelayMs,
        maxTimeout: maxDelayMs,
        randomize: jitter,
        // Conditionally include `signal` — `exactOptionalPropertyTypes` forbids
        // assigning `undefined` to a `signal?: AbortSignal | undefined` field
        // in the Options literal we build here.
        ...(opts.signal ? { signal: opts.signal } : {}),
        onFailedAttempt: (ctx) => {
          // p-retry's `attemptNumber` is 1-based and counts the call that
          // just failed. `retriesLeft` is the number of further retries that
          // will be performed.
          opts.onAttempt?.({
            attempt: ctx.attemptNumber,
            error: ctx.error,
            retriesLeft: ctx.retriesLeft,
          })
        },
      },
    )
    return { kind: "ok", value, attempts: Math.max(1, attempts) }
  } catch (e) {
    // Two paths land here:
    //  (a) retries exhausted — p-retry rejects with the last attempt's error.
    //  (b) AbortError thrown by us — p-retry unwraps and rejects with the
    //      ORIGINAL error (our classified non-retryable). `attempts` reflects
    //      the call count at the moment we classified it.
    //  (c) signal aborted mid-wait — p-retry rejects with the abort reason
    //      (which may not be an Error).
    const err = toError(e)
    return {
      kind: "failed",
      error: err === lastError ? err : (lastError ?? err),
      attempts: Math.max(1, attempts),
    }
  }
}
