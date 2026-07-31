/**
 * Pillar B step — ENV-PREP phase as a self-contained `EvalStep`.
 *
 * Gate: always-on. Env-prep is a baseline harness phase (it runs the instance's
 * `setupCmd` in the sandbox BEFORE the agent, fail-fast). There is no posture
 * knob that turns it off — the driver invokes `runEnvPrep` unconditionally — so
 * the gate is `() => true`, mirroring localize. The byte-identical no-op for an
 * instance with NO `setupCmd` lives INSIDE the delegate (`runEnvPrep` returns
 * `{ok:true}` immediately), so a gated-in env-prep over a setup-less instance is
 * already a no-op.
 *
 * Effect: delegate to the REAL `runEnvPrep` (via `ctx.deps.envPrep`, default the
 * imported function) forwarding `(instance, sandbox, timeoutMs)`, and fold the
 * result into `state.envPrep`. `../env-prep` is a LEAF slice (imports only
 * `exec` + types, never the god-driver), so the direct import is true delegation
 * to existing logic and stays circular-free.
 *
 * The step does NOT abort on `ok:false` — env-prep failure is a fail-fast signal
 * the DRIVER shapes into an `env_prep_failed` verdict (it must not run the agent
 * after). The kernel surfaces the result via state; control-flow recovery is the
 * caller's, matching the kernel's no-swallow contract.
 */

import { runEnvPrep } from "../../env-prep"
import type { EvalCtx, EvalStep } from "../eval-step"
import { foldState } from "../eval-step"

export const envPrepStep: EvalStep = {
  id: "env-prep",
  // Baseline harness phase: included for every posture. The setup-less no-op
  // lives inside `runEnvPrep`, not in the gate.
  gate: () => true,
  run: async (ctx: EvalCtx): Promise<EvalCtx> => {
    // Default the delegate to the REAL env-prep; a test injects a spy to assert
    // delegation without executing a live setup command.
    const delegate = ctx.deps.envPrep ?? runEnvPrep
    const result = await delegate(ctx.instance, ctx.sandbox, ctx.timeoutMs ?? 0)
    return foldState(ctx, { envPrep: result })
  },
}
