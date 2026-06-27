/**
 * Pillar B step — owner-widening REPAIR-ESCALATION FOLLOWUP as an `EvalStep`.
 *
 * Gate: `posture.repairEscalation === true`. This is the posture knob
 * (`repair-escalation`, T-601 multi-owner escalation) that the driver checks
 * before attempting a single-pass followup: absent/false ⇒ the step is excluded
 * ⇒ byte-identical (no widening, no re-run). Moving that boolean into the gate is
 * the Pillar B point.
 *
 * Note there is a SECOND, finer no-op inside the delegate: even with escalation
 * ON, `maybeRunRepairEscalationFollowup` may decide NOT to widen (no new owners
 * beyond those already localized) and return `reran:false`. The step honors that
 * by returning the ctx UNCHANGED on the `reran:false` path — so the gate admits
 * the phase but the delegate's own decision still preserves the no-op invariant.
 *
 * Effect: delegate to the INJECTED `ctx.deps.followup` (the driver binds it over
 * `maybeRunRepairEscalationFollowup`, which re-prepares the attempt context
 * against widened owners and re-runs the phase). When `reran:true`, fold the
 * outcome into `state.followup`. The real fn takes driver-private types, so the
 * driver injects an already-bound thunk and this step only gates + delegates.
 *
 * Wiring-error path: a gated-in step (escalation ON) with no bound delegate
 * throws — symmetric to the other steps; an enabled feature is never laundered
 * into the baseline.
 */

import { foldState } from "../eval-step"
import type { BenchPosture } from "../../knobs-bench"
import type { EvalCtx, EvalStep } from "../eval-step"

/** The followup gate predicate, exported so the parity test asserts against the
 *  EXACT posture flag the driver uses (T-601 repair-escalation). */
export const followupGate = (posture: BenchPosture): boolean => posture.repairEscalation === true

export const followupStep: EvalStep = {
  id: "followup",
  gate: followupGate,
  run: async (ctx: EvalCtx): Promise<EvalCtx> => {
    const delegate = ctx.deps.followup
    if (delegate === undefined) {
      throw new Error("followupStep: gated in but no `deps.followup` delegate bound (wiring error)")
    }
    const outcome = await delegate()
    // The delegate's own "no owners to widen" decision is a no-op: leave ctx
    // unchanged so an enabled-but-inert followup stays byte-identical.
    if (!outcome.reran) return ctx
    return foldState(ctx, { followup: outcome })
  },
}
