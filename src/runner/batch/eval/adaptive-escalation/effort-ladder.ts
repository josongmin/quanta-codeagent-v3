/**
 * Strategy tool #8 — effort ladder (progressive-effort absorption).
 *
 * The adaptive-escalation controller ALREADY climbs an effort ladder: its router
 * picks progressively heavier actions (accept_thin → expand_select → run_repro →
 * proof-clean → repair_with_proof) bounded by {@link DEFAULT_ADAPTIVE_LIMITS}. What
 * it lacks is HEADROOM — on a hard instance the static ceiling (4 steps / 2
 * expensive) stops the climb before the heavy rails are reached. This tool raises
 * that ceiling by an opt-in TIER, letting the existing ladder climb higher.
 *
 * REUSE, NOT REBUILD: the climbing logic (route → admit → execute → re-route) stays
 * in controller.ts; admitNextStep already enforces whatever limits it is handed.
 * This module ONLY computes a taller {@link AdaptiveLimits} and is injected at the
 * controller's existing `limits` seam (adaptive-run.ts `deps.limits`). Default-OFF
 * ⇒ the resolver returns `undefined` ⇒ controller falls back to DEFAULT ⇒
 * byte-identical.
 *
 * NO-MAGIC: the ladder is a pure LINEAR function of the tier, DERIVED from
 * DEFAULT_ADAPTIVE_LIMITS (so a change to the base ladder propagates), with a hard
 * safety cap on the tier to keep the loop bounded. Tier 0 ≡ DEFAULT exactly.
 */

import { type AdaptiveLimits, DEFAULT_ADAPTIVE_LIMITS } from "./transitions"

/** Hard cap on the effort tier — keeps the bounded loop bounded even if the knob is
 *  set absurdly high. At MAX_TIER the ceiling is DEFAULT + (8 steps, 4 expensive, 4
 *  per-action), already well past any productive climb. */
export const MAX_EFFORT_TIER = 4

/**
 * Limits for an effort `tier`, derived linearly from `base`. Tier 0 returns `base`
 * unchanged (the byte-identical invariant). Each tier adds headroom: +2 total steps,
 * +1 expensive step, +1 per-action repeat. `tier` is clamped to [0, MAX_EFFORT_TIER].
 */
export const effortLadderLimits = (
  tier: number,
  base: AdaptiveLimits = DEFAULT_ADAPTIVE_LIMITS,
): AdaptiveLimits => {
  const t = Math.max(0, Math.min(MAX_EFFORT_TIER, Math.floor(tier)))
  return {
    maxTotalSteps: base.maxTotalSteps + 2 * t,
    maxExpensive: base.maxExpensive + t,
    maxPerAction: base.maxPerAction + t,
  }
}

/**
 * Resolve `QUANTA_BENCH_EFFORT_LADDER` → escalated limits, or `undefined` when the
 * knob is unset / `0` / not a positive integer (⇒ controller uses DEFAULT ⇒
 * byte-identical). A positive tier returns {@link effortLadderLimits}(tier).
 */
export const resolveEffortLadderLimits = (
  env: Record<string, string | undefined>,
): AdaptiveLimits | undefined => {
  const raw = env.QUANTA_BENCH_EFFORT_LADDER?.trim()
  if (raw === undefined || raw === "") return undefined
  if (!/^\d+$/.test(raw)) return undefined
  const tier = Number.parseInt(raw, 10)
  if (tier < 1) return undefined
  return effortLadderLimits(tier)
}
