/**
 * Pillar B step — MAIN agent phase as a self-contained `EvalStep`.
 *
 * Gate: always-on. The main phase (`runMainPhase` / `runAppMainPhase`) is the
 * core agent run — every posture executes it (the posture shapes WHICH branch it
 * takes internally: repair phase, single-pass, etc.), so the gate is
 * `() => true`, mirroring localize/env-prep. There is no posture knob that omits
 * the agent run.
 *
 * Effect: delegate to the INJECTED `ctx.deps.mainPhase` and fold the opaque
 * driver `Phase` outcome into `state.mainPhase`. Unlike env-prep/repair, the real
 * main-phase fns are MODULE-PRIVATE to the god-drivers and take their private
 * `RunInstanceDeps` / `Wiring` / `PreparedAttemptContext` shapes — importing them
 * would drag the whole god-module back in (circular) and re-name features. So,
 * exactly as the eval-step.ts contract prescribes for such phases, the driver
 * INJECTS the already-bound main-phase callable and this step only GATES +
 * DELEGATES. The parity test binds a spy.
 *
 * No-op-equivalent / wiring-error path: a gated-in main step with no bound
 * delegate is a WIRING ERROR (throws) — symmetric to localize. The agent run is
 * never silently skipped.
 */

import type { EvalCtx, EvalStep } from "../eval-step"
import { foldState } from "../eval-step"

export const mainPhaseStep: EvalStep = {
  id: "main",
  // The core agent run: included for every posture. The posture selects the
  // internal branch (repair / single-pass), not whether the agent runs.
  gate: () => true,
  run: async (ctx: EvalCtx): Promise<EvalCtx> => {
    const delegate = ctx.deps.mainPhase
    if (delegate === undefined) {
      throw new Error(
        "mainPhaseStep: gated in but no `deps.mainPhase` delegate bound (wiring error)",
      )
    }
    const phase = await delegate()
    return foldState(ctx, { mainPhase: phase })
  },
}
