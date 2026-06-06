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
