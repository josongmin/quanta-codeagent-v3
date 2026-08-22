import type { RateLimitSnapshot } from "./parse"

/**
 * Typed notify event for the proactive rate-limit snapshot — lets a surface
 * render "⚠ rate limit: N tokens left, resets in Ms" (presence / quantity only).
 *
 * NO-LEAK invariant: every field is a NUMBER (or undefined) plus the constant
 * type tag. A header VALUE string (which could carry an org id) is NEVER
 * forwarded. This is a transient UI signal — like `output_progress`, it is NOT
 * folded into the recorder / budget meter, so token accounting is never
 * perturbed. Default-OFF ⇒ never emitted.
 */
export interface RateLimitNotice {
  readonly type: "ratelimit_snapshot"
  readonly requestsRemaining?: number
  readonly requestsResetMs?: number
  readonly tokensRemaining?: number
  readonly tokensResetMs?: number
  readonly observedAt: number
}

/** Project the snapshot onto the no-leak notice (numbers only). */
export const snapshotToNotice = (s: RateLimitSnapshot): RateLimitNotice => ({
  type: "ratelimit_snapshot",
  // Conditional spread keeps absent quantities ABSENT (not `key: undefined`) —
  // required under `exactOptionalPropertyTypes`.
  ...(s.requestsRemaining !== undefined ? { requestsRemaining: s.requestsRemaining } : {}),
  ...(s.requestsResetMs !== undefined ? { requestsResetMs: s.requestsResetMs } : {}),
  ...(s.tokensRemaining !== undefined ? { tokensRemaining: s.tokensRemaining } : {}),
  ...(s.tokensResetMs !== undefined ? { tokensResetMs: s.tokensResetMs } : {}),
  observedAt: s.observedAt,
})
