/**
 * `@/observability/otel-exporter/retry-policy` — how a rejected OTLP batch is
 * classified, and how long the next attempt waits.
 *
 * Split out of `otel-exporter.ts` when retry classification pushed that file
 * into the god-code 900-999 cohort. It is a clean seam: nothing here touches a
 * buffer, a gate or a fetch — it is the pure policy the transport consults.
 */

// ── Retry policy ────────────────────────────────────────────────────────────
// Defaults from the OTLP exporter spec's `RetryConfig` (initial 5s, multiplier
// 1.5, max 30s). Taken verbatim rather than invented so the exporter behaves
// like every other OTLP client an operator has tuned a collector for.
const RETRY_INITIAL_MS = 5_000
const RETRY_MULTIPLIER = 1.5
const RETRY_MAX_MS = 30_000
/** Consecutive failures that may retry with NO delay. The first retry is
 *  immediate: a single dropped connection or a collector mid-restart should
 *  not cost 5s of export latency, and one extra POST is not a thundering
 *  herd. Backoff engages from the SECOND consecutive failure. */
const IMMEDIATE_RETRIES = 1

/** Backoff before the `attempt`-th consecutive retry (1-based). */
export const backoffMs = (attempt: number): number => {
  if (attempt <= IMMEDIATE_RETRIES) return 0
  const scaled = RETRY_INITIAL_MS * RETRY_MULTIPLIER ** (attempt - IMMEDIATE_RETRIES - 1)
  return Math.min(scaled, RETRY_MAX_MS)
}

/** What to do with a batch whose POST came back non-2xx.
 *
 *  The bug this exists for: `post` used to collapse EVERY non-2xx into `false`,
 *  and the flush paths treat `false` as "put it back at the FRONT of the
 *  buffer". A 400/401/404 — bytes the collector will reject identically every
 *  time — was therefore re-POSTed forever, and the buffer cap could not drain
 *  it because `boundedPush` only evicts when NEW records arrive. Measured on
 *  that code: cap 3, 50 flushes → 50 POSTs.
 *
 *    - 408 / 429  → RETRY. 4xx by number, transient by meaning (timeout,
 *                   throttle); 429 is the one the collector uses to ask for
 *                   backpressure, so dropping it would be exactly backwards.
 *    - other 4xx  → DROP. Malformed payload, bad/expired credentials, wrong
 *                   path. Re-sending identical bytes cannot change the answer.
 *    - 5xx        → RETRY. The collector is unhealthy, the bytes are fine.
 *    - 1xx / 3xx  → DROP. Not a state a resend makes progress from (an
 *                   unfollowable redirect / a misconfigured endpoint); `fetch`
 *                   follows real redirects itself, so seeing one here is a
 *                   configuration fault, not a blip.
 */
export type PostDisposition = "retry" | "drop"

export const classifyPostStatus = (status: number): PostDisposition => {
  if (status === 408 || status === 429) return "retry"
  if (status >= 500) return "retry"
  return "drop"
}

/** Honour `Retry-After` when the collector sends one (delta-seconds form). The
 *  HTTP-date form is deliberately NOT parsed — it needs a trusted clock and the
 *  exponential fallback is already correct — so it degrades to backoff rather
 *  than to a wrong deadline. Uncapped on purpose: the collector is the
 *  authority on when it can accept again, and the buffer cap still bounds
 *  memory while we wait. */
export const parseRetryAfterMs = (raw: string | null | undefined): number | undefined => {
  if (raw === null || raw === undefined || raw.trim() === "") return undefined
  const seconds = Number(raw)
  if (!Number.isFinite(seconds) || seconds < 0) return undefined
  return seconds * 1000
}

/** Outcome of one POST attempt. */
export type PostOutcome =
  | { readonly kind: "ok" }
  | {
      readonly kind: "retry"
      readonly retryAfterMs: number | undefined
      /** Human-readable cause (`HTTP 503`, `ECONNREFUSED`) for the operator-
       *  facing warn. A retry that cannot name its cause is a retry an operator
       *  cannot act on — the regression this field exists to prevent. */
      readonly reason: string
    }
  | { readonly kind: "drop"; readonly reason: string }
