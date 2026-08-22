/** Backoff policy for the MCP auto-restart supervisor (ADR-0435).
 *
 *  Absorbs Cursor's `mcpProcessMain.js` reconnect algorithm verbatim: a
 *  two-phase capped-exponential + full-jitter backoff. Every constant here is a
 *  typed config value with a documented rationale traced to the Cursor source —
 *  there are NO magic thresholds buried in the supervisor. */

/** Two-phase reconnect timing + storm caps.
 *
 *  Phase 1 ("fast"): aggressive retries immediately after a crash, capped at
 *  {@link maxFastAttempts}. Phase 2 ("periodic"): once fast is exhausted, slow
 *  periodic retries capped at {@link maxPeriodicCycles}. Both phases use the
 *  same `backoffDelay` formula (capped-exponential + full-jitter) over their
 *  own base/max pair. All defaults trace to Cursor (`:19065`). */
export interface BackoffPolicy {
  /** Fast-retry base delay. Cursor `Dv = 5e3`. attempt=0 ⇒ exactly this (no jitter). */
  readonly fastRetryBaseMs: number
  /** Fast-retry ceiling. Cursor `Nv = 6e4`. The capped-exponential never exceeds this. */
  readonly fastRetryMaxMs: number
  /** Periodic-retry base delay. Cursor `Fv = 5 * 6e4`. */
  readonly periodicBaseMs: number
  /** Periodic-retry ceiling. Cursor `Uv = 30 * 6e4`. */
  readonly periodicMaxMs: number
  /** Number of fast-retry attempts before entering the periodic phase. Cursor
   *  `getFastRetryMaxAttempts`. */
  readonly maxFastAttempts: number
  /** Number of periodic cycles before permanent give-up (→ DEGRADED). Cursor
   *  `getMaxPeriodicCycles`. */
  readonly maxPeriodicCycles: number
  /** A server that stays up this long after a restart is considered stable; the
   *  attempt/cycle counters reset so the next crash starts fresh fast-retries.
   *  Cursor `getStabilityThresholdMs`. The core flapping guard. */
  readonly stabilityThresholdMs: number
}

/** Defaults — every value traced to Cursor `mcpProcessMain.js` (§1 of the RFC).
 *  These are the only timing constants in the slice; the supervisor reads them
 *  from here, never hard-codes. */
export const DEFAULT_BACKOFF_POLICY: BackoffPolicy = {
  fastRetryBaseMs: 5_000, // Cursor Dv
  fastRetryMaxMs: 60_000, // Cursor Nv
  periodicBaseMs: 300_000, // Cursor Fv (5 * 6e4)
  periodicMaxMs: 1_800_000, // Cursor Uv (30 * 6e4)
  maxFastAttempts: 5, // Cursor getFastRetryMaxAttempts default
  maxPeriodicCycles: 5, // Cursor getMaxPeriodicCycles default
  stabilityThresholdMs: 60_000, // Cursor getStabilityThresholdMs default
}

/** Capped-exponential + full-jitter backoff. Absorbs Cursor `Fd` (`:19125`)
 *  byte-for-byte:
 *
 *    capped = min(base * 2^attempt, max)
 *    return capped <= base ? base : base + random() * (capped - base)
 *
 *  `attempt=0` ⇒ `capped === base` ⇒ returns exactly `base` (no jitter), which
 *  matches Cursor. For attempt>0 the result is uniform over `[base, capped]`
 *  (AWS "full jitter" — thundering-herd avoidance).
 *
 *  `random` is INJECTED (default `Math.random`) so tests are deterministic and
 *  the supervisor never reaches for a global RNG. */
export const backoffDelay = (
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number => {
  // `Ds`-style clamp guard: a pathological config (max < base, negative base)
  // must never yield a delay outside [base, max]. We clamp the ceiling to be at
  // least `base` so `capped <= base` short-circuits to `base` (Cursor-equivalent
  // safe behavior). Negative base is floored to 0 so the result is non-negative.
  const safeBase = baseMs < 0 ? 0 : baseMs
  const safeMax = maxMs < safeBase ? safeBase : maxMs
  const capped = Math.min(safeBase * 2 ** attempt, safeMax)
  return capped <= safeBase ? safeBase : safeBase + random() * (capped - safeBase)
}
