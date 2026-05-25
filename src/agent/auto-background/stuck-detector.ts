/**
 * Pure stuck-detection primitives (ADR-0223).
 *
 * This module is the PURE-FUNCTIONAL kernel of the auto-background slice —
 * stateless helpers that compute "is this elapsed time past the threshold?"
 * and project a {@link StuckProbeResult}. Split from `default-tracker.ts`
 * (the stateful `Map`-backed bookkeeping impl) so:
 *
 *   1. The threshold arithmetic is single-sourced — a host that wires a
 *      DIFFERENT storage layer (e.g. SQLite-backed for cross-restart
 *      durability, or a Redis-backed multi-process detector) can reuse the
 *      math via {@link computeStuckProbe} without forking the rule.
 *
 *   2. Tests can exercise the threshold semantics WITHOUT instantiating a
 *      detector — single-function pure tests for the `>=` boundary, NaN
 *      propagation, negative-elapsed guard, etc.
 *
 *   3. The default-tracker stays thin: its responsibility is the `Map` +
 *      lifecycle, not the threshold algebra.
 *
 * SOLID: this file IS the strategy in the Strategy pattern. The detector
 * COMPOSES the strategy (`computeStuckProbe`) with state (`Map`).
 *
 * NO-THROW: every helper is total — NaN / Infinity / negative elapsed values
 * propagate to a structurally-honest result. We do not coerce to 0 because
 * that would mask clock-injection bugs (see port.ts §clock-bugs).
 */

import { DEFAULT_STUCK_THRESHOLD_MS, type StuckProbeResult } from "./port"

/** Pure: compute the {@link StuckProbeResult} for one (startTimeMs, now,
 *  threshold) tuple. Used by {@link defaultStuckDetector} and re-usable by
 *  any caller that wires a non-default storage layer.
 *
 *  Decisions:
 *   - `elapsedMs = now - startTimeMs` — signed (a clock that went backwards
 *     yields a negative elapsed, and the result is `stuck:false` because a
 *     negative number is never `>= threshold`).
 *   - `stuck = elapsedMs >= threshold` — INCLUSIVE at the boundary so the UX
 *     phrasing "after 2 s" matches the test pin (HELL-AB-02).
 *   - NaN input ⇒ `elapsedMs:NaN`, `stuck:false` (NaN comparisons are
 *     always false in JS). Intentional: surfaces the bug without throwing.
 */
export const computeStuckProbe = (input: {
  readonly startTimeMs: number
  readonly now: number
  readonly threshold: number
}): StuckProbeResult => {
  const elapsedMs = input.now - input.startTimeMs
  return {
    stuck: elapsedMs >= input.threshold,
    elapsedMs,
    threshold: input.threshold,
  }
}

/** Pure: build the "not tracking this id" result (a shape-stable zero so the
 *  caller may unconditionally read `elapsedMs` without a branch). Threshold
 *  is echoed so the result type is uniform across hit/miss. */
export const stuckProbeAbsent = (threshold: number): StuckProbeResult => ({
  stuck: false,
  elapsedMs: 0,
  threshold,
})

/** Pure: normalize a caller-supplied threshold to the production-safe range.
 *  A non-finite / non-positive value coerces to {@link
 *  DEFAULT_STUCK_THRESHOLD_MS}. The port contract is no-throw, so we DO NOT
 *  raise on bogus input — we pick a safe default and let the host observe
 *  the chosen value via the result's `threshold` field. */
export const normalizeThreshold = (raw: number | undefined): number => {
  if (raw === undefined) return DEFAULT_STUCK_THRESHOLD_MS
  if (!Number.isFinite(raw)) return DEFAULT_STUCK_THRESHOLD_MS
  if (raw <= 0) return DEFAULT_STUCK_THRESHOLD_MS
  return raw
}

// Re-export so callers can `import {DEFAULT_STUCK_THRESHOLD_MS} from
// "./stuck-detector"` for ergonomic discovery (the named constant logically
// belongs to the threshold algebra, not the port type surface — but it lives
// in port.ts as the cross-module SSOT, so this is a re-export, not a fork).
export { DEFAULT_STUCK_THRESHOLD_MS }
