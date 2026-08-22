/**
 * Pillar B step — REPAIR-ROUNDS phase as a self-contained `EvalStep`.
 *
 * Gate: `posture.repairRounds !== undefined`. This is the SAME presence-check the
 * driver uses to decide whether the ClosureBundle becomes a repair executor
 * (BenchPosture.repairRounds doc: "undefined ⇒ the preset declares no repair").
 * Absent ⇒ this step is excluded ⇒ byte-identical single-pass (no repair loop).
 *
 * Effect: delegate to the REAL `runRepairRounds` (via `ctx.deps.repair`, default
 * the imported function) with the args the driver pre-composed in
 * `ctx.deps.repairArgs`, and fold the result into `state.repair`. The repair
 * orchestrator is imported DIRECTLY here because `../repair` is a leaf slice with
 * no god-driver dependency (it never imports `@/agent` or the driver) — so this
 * is true delegation to existing logic, not a reimplementation, and stays
 * circular-free.
 *
 * No-op-equivalent path: a gated-in repair step with no `repairArgs` bound is a
 * wiring error (throws) — the posture asked for repair rounds but the driver
 * forwarded nothing. Symmetric to the localize/repro steps.
 */

import type { BenchPosture } from "../../knobs-bench"
import { runRepairRounds } from "../../repair/index"
import type { EvalCtx, EvalStep } from "../eval-step"
import { foldState } from "../eval-step"

/** The repair gate predicate, exported for the parity test to assert the EXACT
 *  driver predicate (presence of a repair-round budget). */
export const repairGate = (posture: BenchPosture): boolean => posture.repairRounds !== undefined

export const repairStep: EvalStep = {
  id: "repair",
  gate: repairGate,
  run: async (ctx: EvalCtx): Promise<EvalCtx> => {
    const args = ctx.deps.repairArgs
    if (args === undefined) {
      throw new Error("repairStep: gated in but no `deps.repairArgs` bound (wiring error)")
    }
    // Default the delegate to the REAL orchestrator; a test injects a spy via
    // `deps.repair` to assert delegation without running a live agent loop.
    const delegate = ctx.deps.repair ?? runRepairRounds
    const result = await delegate(args)
    return foldState(ctx, { repair: result })
  },
}
