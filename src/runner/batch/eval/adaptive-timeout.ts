/**
 * Adaptive per-instance timeout: scale `baseMs` by the sum of active bench
 * knobs' `costMultiplier`. Pure — depends only on inputs, no env reads, no
 * registry mutation.
 *
 * Contract (byte-identical fence):
 *   - `BenchKnobState.values.size === 0` (empty registry OR no knob resolved)
 *     ⇒ `costMult === 1` ⇒ adapted timeout EQUALS `baseMs`. The pre-feature
 *     bench path never observed an adapted value — same number, same shape.
 *   - Each active knob's `costMultiplier` defaults to 1 (matches the matrix
 *     budget contract documented on the `Knob` interface). A knob with no
 *     `costMultiplier` field contributes exactly 1 to the sum (so a single
 *     active boolean knob like `must-pass` doubles the timeout if the cost
 *     dimension is left implicit).
 *
 * Why the sum (NOT product): the existing telemetry `emitKnobsApplied` in
 * `driver.ts` ALREADY sums costMultipliers as the matrix-budget contract
 * (`Σ(active)`). We mirror that exact computation here so a per-condition
 * sweep cell reports one consistent cost number across both the trajectory
 * `knobs_applied` line and the adaptive-timeout report field.
 *
 * Hard ceiling: `MAX_TIMEOUT_MS = 30 * 60 * 1000` (30 min). A K=5 repro-test
 * + K=3 branch-search posture would otherwise blow past 1 hour against a 10
 * min base — the cap matches the bench operator's wall-clock patience and
 * keeps a misconfigured matrix sweep from wedging a CI lane indefinitely.
 *
 * Defensive parsing — handles every shape the knob's static `costMultiplier`
 * could leak (NaN, Infinity, negative, undefined, 0): each invalid value
 * contributes `1` to the sum (active-knob default per the matrix contract).
 */

import type { BenchKnobState } from "./knobs-bench"

/** Hard upper bound on the adapted timeout, regardless of how many knobs are
 *  active. Keeps a misconfigured sweep from wedging the lane. */
export const MAX_TIMEOUT_MS = 30 * 60 * 1000

/** Sum the `costMultiplier` field of each ACTIVE knob in `state` (each
 *  invalid / absent value contributes 1, the matrix-budget default). Returns
 *  `1` when no knob is active (byte-identical sentinel — caller's
 *  `baseMs * 1 === baseMs`).
 *
 *  Exported separately so the unit tests can pin the cost projection
 *  independently of the timeout-clamp logic. */
export const sumCostMultipliers = (state: BenchKnobState): number => {
  if (state.values.size === 0) return 1
  let cost = 0
  for (const id of state.values.keys()) {
    const knob = state.knobs.get(id)
    const m = knob?.costMultiplier
    cost += typeof m === "number" && Number.isFinite(m) && m > 0 ? m : 1
  }
  // Defensive: if every active knob had a garbage costMultiplier, `cost`
  // would still be >= state.values.size (each contributed 1). But if the
  // values map somehow has entries that aren't in `knobs` (registry skew),
  // `knob` is undefined ⇒ contributes 1 ⇒ cost === values.size >= 1.
  return cost
}

/** Compute the adapted timeout for the current bench knob posture.
 *
 *  Returns:
 *    - `baseMs` (byte-identical) when no knob is active OR every active
 *      knob has `costMultiplier <= 1` (the matrix-budget default).
 *    - `baseMs * Σ(active costMultipliers)` clamped to `[baseMs,
 *      MAX_TIMEOUT_MS]`. Lower clamp guards against a hypothetical
 *      knob with `costMultiplier < 1` — adaptive timeout should NEVER
 *      shrink the budget (timeout is a CAP, not a target).
 *
 *  Pure: no `process.env`, no fs, no registry mutation. The function is
 *  referentially transparent over its two inputs.
 *
 *  Domain guards on `baseMs`:
 *    - `baseMs <= 0` / NaN / Infinity ⇒ returns `0` (caller will treat as
 *      "no timeout configured" — the bench's `setTimeout(..., 0)` schedules
 *      an immediate abort, which is the intended fail-fast posture when
 *      someone passes garbage). */
export const computeAdaptedTimeout = (baseMs: number, state: BenchKnobState): number => {
  if (!Number.isFinite(baseMs) || baseMs <= 0) return 0
  const cost = sumCostMultipliers(state)
  // Defensive lower clamp: cost < 1 ⇒ pin to 1 (never shrink the base
  // timeout — that would silently move the goalpost in the wrong direction).
  const effectiveCost = Math.max(1, cost)
  const adapted = baseMs * effectiveCost
  if (adapted > MAX_TIMEOUT_MS) return MAX_TIMEOUT_MS
  return adapted
}
