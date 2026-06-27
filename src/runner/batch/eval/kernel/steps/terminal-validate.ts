/**
 * Pillar B step — TERMINAL-RESULT validation as a self-contained `EvalStep`.
 *
 * Gate: always-on. `maybeValidateTerminalResult` is invoked unconditionally at
 * the end of every attempt (it folds gold-validation + late-failure artifacts
 * onto the terminal result); there is no posture knob that omits it. The gate is
 * `() => true`. Its byte-identical no-op (a phase with no terminal result yet)
 * lives INSIDE the delegate, which returns `undefined` — the step then leaves the
 * ctx unchanged.
 *
 * Effect: delegate to the INJECTED `ctx.deps.terminalValidate` and fold the
 * opaque terminal `InstanceResult` into `state.terminalResult`. When the delegate
 * yields `undefined` (no terminal result to validate), the ctx is returned
 * UNCHANGED, preserving the no-op invariant. Like main-phase, the real fn
 * (`maybeValidateTerminalResult`) takes the driver's private `Phase` /
 * `RunInstanceDeps` / `Wiring` / `PreparedAttemptContext` shapes, so the driver
 * INJECTS an already-bound thunk and this step only gates + delegates.
 *
 * Wiring-error path: a gated-in step with no bound delegate throws — symmetric to
 * the other always-on steps; terminal validation is never silently skipped.
 */

import { foldState } from "../eval-step"
import type { EvalCtx, EvalStep } from "../eval-step"

export const terminalValidateStep: EvalStep = {
  id: "terminal-validate",
  // Invoked at the end of every attempt; the "no terminal result yet" no-op
  // lives inside the delegate (returns undefined), not in the gate.
  gate: () => true,
  run: async (ctx: EvalCtx): Promise<EvalCtx> => {
    const delegate = ctx.deps.terminalValidate
    if (delegate === undefined) {
      throw new Error(
        "terminalValidateStep: gated in but no `deps.terminalValidate` delegate bound (wiring error)",
      )
    }
    const result = await delegate()
    if (result === undefined) return ctx
    return foldState(ctx, { terminalResult: result })
  },
}
