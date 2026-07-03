/**
 * jun-6 — account rate-limit snapshot parser (PURE, default-OFF slice).
 *
 * Reads the provider's LIVE quota meter off a response's headers — the
 * remaining-quota / reset family that Anthropic (`anthropic-ratelimit-*`) and
 * OpenAI (`x-ratelimit-*`) return on EVERY response, not just on a 429. This is
 * the PROACTIVE half of rate-limit handling: B3 (`parseRetryAfterMs`,
 * `src/shared/errors.ts`) reads `retry-after` AFTER a 429; this reads the
 * remaining/reset BEFORE one fires.
 *
 * Constraints (project rules):
 *   - NO invented number: a field is populated ONLY when the provider sent a
 *     well-formed value. Garbage ⇒ field absent (never coerced to 0 / NaN).
 *   - NO-THROW: a hostile header getter degrades to "no snapshot".
 *   - NO Date.now: `now` is injected.
 *   - Reset disambiguation REUSES B3's magnitude-band + HTTP-date discipline
 *     (epoch-ms ≥1e12 / epoch-s ≥1e9 / relative-s, past ⇒ undefined). The band
 *     function {@link parseRateLimitResetMs} is a closed duplicate of B3's
 *     private `parseRateLimitResetHeader`, locked to the original by a
 *     differential-parity test (the original is not exported, and its file —
 *     the LLM error boundary — is out of scope to edit).
 */

/** Case-insensitive header accessor — the SAME shape `errors.ts` exposes as
 *  `HeaderLookup`, re-declared here so the slice imports nothing from the error
 *  boundary. */
export type HeaderLookup = (name: string) => string | null

export interface RateLimitSnapshot {
  /** Requests left in the current primary window (provider-reported). */
  readonly requestsRemaining?: number
  /** ms until the request window resets (relative, via the B3 band parser). */
  readonly requestsResetMs?: number
  /** Tokens left in the current primary window (provider-reported). */
  readonly tokensRemaining?: number
  /** ms until the token window resets (relative). */
  readonly tokensResetMs?: number
  /** Injected-clock observation time (ms-epoch) — when the snapshot was read. */
  readonly observedAt: number
}

/**
 * Closed allowlist of header spellings, both vendor families. Anthropic uses
 * `anthropic-ratelimit-{requests,tokens}-{remaining,reset}`; OpenAI mirrors with
 * `x-ratelimit-{remaining,reset}-{requests,tokens}`. Unknown headers are
 * ignored. Lookups are case-insensitive (handled by the caller's accessor), so
 * lowercase canonical names suffice.
 */
const REQUESTS_REMAINING = [
  "anthropic-ratelimit-requests-remaining",
  "x-ratelimit-remaining-requests",
] as const
const REQUESTS_RESET = ["anthropic-ratelimit-requests-reset", "x-ratelimit-reset-requests"] as const
const TOKENS_REMAINING = [
  "anthropic-ratelimit-tokens-remaining",
  "x-ratelimit-remaining-tokens",
] as const
const TOKENS_RESET = ["anthropic-ratelimit-tokens-reset", "x-ratelimit-reset-tokens"] as const

// jul-03 B3 — the PAIRED window CAPACITY (the denominator for a count-based
// remaining%). OpenAI reports `x-ratelimit-limit-{requests,tokens}`; Anthropic
// mirrors with `anthropic-ratelimit-{requests,tokens}-limit`. Unlike Codex
// (which sends a used-PERCENT directly), these providers send raw COUNTS, so the
// remaining fraction is `remaining / limit`. Same lowercase-canonical / vendor-
// family posture as the `*-remaining` allowlists above.
const REQUESTS_LIMIT = ["anthropic-ratelimit-requests-limit", "x-ratelimit-limit-requests"] as const
const TOKENS_LIMIT = ["anthropic-ratelimit-tokens-limit", "x-ratelimit-limit-tokens"] as const

/** First non-null value across an allowlist of spellings. No-throw: a hostile
 *  getter is caught and treated as "absent". */
const firstOf = (get: HeaderLookup, names: readonly string[]): string | null => {
  for (const name of names) {
    let raw: string | null
    try {
      raw = get(name)
    } catch {
      return null
    }
    if (raw !== null) return raw
  }
  return null
}

/** Parse a `*-remaining` count: a non-negative SAFE integer the provider
 *  reported. Anything else (negative, NaN, fractional, or an unsafe magnitude
 *  beyond 2^53 that lost precision in `Number()`) ⇒ `undefined` so the field
 *  stays absent rather than fabricating a count that does not round-trip. */
const parseRemaining = (raw: string | null): number | undefined => {
  if (raw === null) return undefined
  const trimmed = raw.trim()
  if (trimmed === "") return undefined
  const n = Number(trimmed)
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined
}

/** Upper bound on a usable reset delay: one year. A provider/proxy that
 *  surfaces an absurd magnitude (a far-future epoch, a mis-scaled value) would
 *  otherwise yield a multi-thousand-year "reset" — never a real quota window.
 *  Such a value is clamped to `undefined` (surfaced-raw hardening) so a junk
 *  meter never drives a multi-millennium proactive delay. */
export const MAX_RESET_HORIZON_MS = 365 * 24 * 60 * 60 * 1000

/** Final guard shared by every band: a delay must be finite, non-negative, and
 *  within the {@link MAX_RESET_HORIZON_MS} horizon, else `undefined`. */
const withinHorizon = (ms: number | undefined): number | undefined =>
  ms !== undefined && ms <= MAX_RESET_HORIZON_MS ? ms : undefined

/** Resolve a NUMERIC (already-`Number()`'d, finite) reset value by magnitude
 *  band, matching B3's split. A negative ⇒ `undefined` (parity: it must NOT
 *  leak into the HTTP-date branch). The result is horizon-clamped. */
const resolveNumericReset = (n: number, now: () => number): number | undefined => {
  if (n < 0) return undefined
  const nowMs = now()
  if (n >= 1_000_000_000_000) {
    const delta = n - nowMs
    return withinHorizon(delta >= 0 ? finiteMs(Math.round(delta)) : undefined)
  }
  if (n >= 1_000_000_000) {
    const delta = n * 1000 - nowMs
    return withinHorizon(delta >= 0 ? finiteMs(delta) : undefined)
  }
  return withinHorizon(finiteMs(Math.round(n * 1000)))
}

/**
 * `*-reset`: ambiguous in the wild — disambiguate by MAGNITUDE, exactly as B3's
 * private `parseRateLimitResetHeader` (`src/shared/errors.ts`) does:
 *   - `n ≥ 1e12`  absolute epoch-MILLISECONDS — delta = `n − nowMs` (NO ×1000).
 *   - `n ≥ 1e9`   absolute epoch-SECONDS — delta = `n×1000 − nowMs`.
 *   - otherwise   relative delta-seconds — `n×1000`.
 * Also accepts an HTTP-date (RFC 9110) form as a SUPERSET (B3 has no such
 * fallback). A past / non-finite / negative value ⇒ `undefined`; a value beyond
 * the 1-year horizon ⇒ `undefined`. The HTTP-date branch is taken ONLY when the
 * raw is NOT a finite number — a numeric-but-rejected value (e.g. a negative
 * like `"-91645"`) stays `undefined` instead of leaking into `Date.parse`,
 * preserving byte-for-byte band parity with B3. A differential-parity test locks
 * both the parity and the two documented divergences.
 */
export const parseRateLimitResetMs = (
  raw: string | null,
  now: () => number,
): number | undefined => {
  if (raw === null) return undefined
  // NOTE: match B3 EXACTLY (no early empty-string short-circuit). B3's
  // `parseRateLimitResetHeader` does `Number(raw.trim())`, and `Number("")` /
  // `Number("   ")` is `0` ⇒ a 0ms relative reset. The differential-parity test
  // locks this; diverging here would silently desync the band logic.
  const trimmed = raw.trim()
  const n = Number(trimmed)
  // Numeric input: a negative (or out-of-band) value resolves HERE — it must NOT
  // fall through to the HTTP-date branch (B3 rejects it, so parity requires the
  // same; `Date.parse("-91645")` would otherwise fabricate a far-future date).
  if (Number.isFinite(n)) return resolveNumericReset(n, now)
  // HTTP-date form (e.g. "Wed, 21 Oct 2026 07:28:00 GMT") — superset over B3.
  const at = Date.parse(trimmed)
  if (!Number.isFinite(at)) return undefined
  const delta = at - now()
  return withinHorizon(delta >= 0 ? finiteMs(delta) : undefined)
}

/** Mirror of B3's `finiteMs`: a delay MUST be finite + non-negative or
 *  `undefined`. Normalizes `-0`→`0`, maps non-finite (overflow) ⇒ `undefined`. */
const finiteMs = (ms: number): number | undefined =>
  Number.isFinite(ms) && ms >= 0 ? ms + 0 : undefined

/**
 * Parse a {@link RateLimitSnapshot} from a response's headers. Returns
 * `undefined` when NO recognized header is present (most non-Anthropic / proxy
 * responses) — the store then keeps its last value / stays empty ⇒ zero
 * behavior (byte-identical to today's reactive 429-retry).
 */
export const parseRateLimitSnapshot = (
  get: HeaderLookup,
  now: () => number,
): RateLimitSnapshot | undefined => {
  const requestsRemaining = parseRemaining(firstOf(get, REQUESTS_REMAINING))
  const requestsResetMs = parseRateLimitResetMs(firstOf(get, REQUESTS_RESET), now)
  const tokensRemaining = parseRemaining(firstOf(get, TOKENS_REMAINING))
  const tokensResetMs = parseRateLimitResetMs(firstOf(get, TOKENS_RESET), now)

  // No recognized signal at all ⇒ no snapshot. (Each field is undefined when its
  // header is absent OR garbage; if all four are undefined there is nothing to
  // observe and we must not clobber the store.)
  if (
    requestsRemaining === undefined &&
    requestsResetMs === undefined &&
    tokensRemaining === undefined &&
    tokensResetMs === undefined
  ) {
    return undefined
  }

  // Conditional spread so absent fields stay ABSENT (not `key: undefined`) —
  // required under `exactOptionalPropertyTypes`.
  return {
    ...(requestsRemaining !== undefined ? { requestsRemaining } : {}),
    ...(requestsResetMs !== undefined ? { requestsResetMs } : {}),
    ...(tokensRemaining !== undefined ? { tokensRemaining } : {}),
    ...(tokensResetMs !== undefined ? { tokensResetMs } : {}),
    observedAt: now(),
  }
}

/** Parse a `*-limit` CAPACITY: a STRICTLY-positive SAFE integer (a window
 *  denominator). Zero / negative / non-integer / unsafe-magnitude ⇒ `undefined`
 *  so a junk capacity can never drive a divide-by-zero or an out-of-band
 *  fraction (mirrors {@link parseRemaining}, but excludes 0 — a zero-capacity
 *  window carries no usable fraction). */
const parseLimit = (raw: string | null): number | undefined => {
  if (raw === null) return undefined
  const trimmed = raw.trim()
  if (trimmed === "") return undefined
  const n = Number(trimmed)
  return Number.isSafeInteger(n) && n > 0 ? n : undefined
}

/** Remaining% for ONE count-based window, or `undefined` when the pair is
 *  incomplete or nonsensical. A window contributes ONLY when BOTH a well-formed
 *  non-negative remaining AND a well-formed positive limit are present, and
 *  `remaining <= limit` (a provider that reports remaining>limit is malformed —
 *  skip rather than fabricate a >100 figure). NO invented number: a missing or
 *  garbage side ⇒ `undefined`. */
const windowRemainingPercent = (
  get: HeaderLookup,
  remainingNames: readonly string[],
  limitNames: readonly string[],
): number | undefined => {
  const remaining = parseRemaining(firstOf(get, remainingNames))
  const limit = parseLimit(firstOf(get, limitNames))
  if (remaining === undefined || limit === undefined) return undefined
  if (remaining > limit) return undefined
  // `remaining * 100 / limit` (multiply FIRST): for integer counts this yields
  // an exact result whenever `limit` divides `remaining * 100` (e.g. 7/100 ⇒ 7,
  // not 7.000000000000001), avoiding a float artifact that `(remaining/limit)*100`
  // introduces. Guard the intermediate: only multiply-first while `remaining*100`
  // stays a SAFE integer (real token/request counts are ≤ millions, so this always
  // holds); a pathological near-2^53 limit falls back to divide-first so we never
  // return a value corrupted by silent integer-overflow rounding.
  const scaled = remaining * 100
  return Number.isSafeInteger(scaled) ? scaled / limit : (remaining / limit) * 100
}

/**
 * jul-03 B3 — provider rate-limit remaining PERCENTAGE derived from the
 * count/limit header pairs OpenAI (`x-ratelimit-{remaining,limit}-{requests,
 * tokens}`) and Anthropic (`anthropic-ratelimit-{requests,tokens}-{remaining,
 * limit}`) send on EVERY response. This is the second provider source for the
 * memory write-guard's provider arm: those vendors report raw COUNTS (unlike
 * Codex's used-PERCENT), so with no count→percent derivation the guard's
 * provider tap stayed `undefined` and fail-open forever on them.
 *
 * remaining% = remaining / limit * 100, computed PER window (requests, tokens);
 * the MIN across the recognized windows governs (the tightest constraint is the
 * one about to throttle — parity with the Codex "fast window governs" choice).
 * Result clamped into the documented [0,100] band (defensive; the pair-validity
 * checks already bound it). Returns `undefined` when NEITHER window carries a
 * complete, well-formed pair, so the caller keeps its last value / fails open.
 *
 * Constraints (project rules — identical posture to {@link parseRateLimitSnapshot}):
 *   - NO invented number: an incomplete / garbage pair contributes nothing.
 *   - NO-THROW: a hostile getter degrades to "no percentage" (via `firstOf`).
 *   - Stateless / clock-free: a pure projection of the current headers.
 */
export const parseCountRemainingPercent = (get: HeaderLookup): number | undefined => {
  const perWindow = [
    windowRemainingPercent(get, REQUESTS_REMAINING, REQUESTS_LIMIT),
    windowRemainingPercent(get, TOKENS_REMAINING, TOKENS_LIMIT),
  ].filter((p): p is number => p !== undefined)
  if (perWindow.length === 0) return undefined
  const min = Math.min(...perWindow)
  // Defensive clamp: the pair checks already keep this in [0,100], but never let
  // a rounding artifact or future spelling drift emit an out-of-band percentage.
  return Math.min(100, Math.max(0, min))
}
