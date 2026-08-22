/**
 * Pillar B step — LOCALIZE phase as a self-contained `EvalStep`.
 *
 * Gate: the localize phase runs whenever the posture asks for it. Today the
 * driver always localizes, with the `localizePhase` config tuning HOW (LSP
 * grounding steer, phase-1 turn budget, …). The gate mirrors that: included when
 * the posture declares a `localizePhase` config OR unconditionally (localization
 * is the baseline first phase). We model it as "always on for the eval pipeline"
 * — the posture's `localizePhase` shapes the delegate the driver binds, not
 * whether localization happens. (When a future preset wants NO localization it
 * would bind no `localize` delegate; see the wiring-error guard below.)
 *
 * Effect: delegate to the injected localizer and fold the ranked candidates into
 * `state.localizeCandidates`. No-op-equivalent path: a gated-in step whose
 * delegate is absent is a WIRING ERROR (the posture wanted localization but the
 * driver bound none) — it throws rather than silently dropping the phase, so a
 * mis-wired feature can never masquerade as a byte-identical baseline. When the
 * delegate is present but yields no candidates, the ctx is returned unchanged
 * (empty contribution), preserving the no-op invariant.
 *
 * Delegation only: this file does NOT reimplement the localizer; it calls
 * `ctx.deps.localize`, which the driver binds over its private LLM port + sandbox.
 */

import type { EvalCtx, EvalStep } from "../eval-step"
import { foldState } from "../eval-step"

export const localizeStep: EvalStep = {
  id: "localize",
  // Localization is the baseline first phase: included for every posture. The
  // `localizePhase` config tunes the delegate, not the gate.
  gate: () => true,
  run: async (ctx: EvalCtx): Promise<EvalCtx> => {
    const delegate = ctx.deps.localize
    if (delegate === undefined) {
      throw new Error("localizeStep: gated in but no `deps.localize` delegate bound (wiring error)")
    }
    const candidates = await delegate()
    if (candidates.length === 0) return ctx
    return foldState(ctx, { localizeCandidates: candidates })
  },
}
