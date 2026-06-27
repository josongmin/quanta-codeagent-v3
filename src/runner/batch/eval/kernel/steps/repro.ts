/**
 * Pillar B step — REPRODUCTION-TEST phase as a self-contained `EvalStep`.
 *
 * Gate: `posture.reproTestK !== undefined && posture.reproTestK >= 1`. This is
 * the SAME predicate the driver's `prepareReproTest` uses internally (K absent /
 * < 1 ⇒ disabled, byte-identical to no repro phase). Moving it into the gate is
 * the whole point of Pillar B: the driver's inline `if (posture.reproTestK …)`
 * becomes this step's `gate`, and the engine never names the feature.
 *
 * Effect: delegate to the injected repro generator and fold the selected
 * reproducer source into `state.reproSource`. No-op-equivalent path: when the
 * delegate yields `undefined` (no candidate reproduced — the documented `null`
 * outcome of `prepareReproTest`), the ctx is returned UNCHANGED, byte-identical
 * to the K-disabled path. A gated-in step with no bound delegate is a wiring
 * error (throws) for the same reason as localize: a posture that turned repro ON
 * must not silently degrade to the baseline.
 *
 * Delegation only: this file does NOT reimplement repro generation/selection; it
 * calls `ctx.deps.repro`, which the driver binds over `prepareReproTest`.
 */

import { foldState } from "../eval-step"
import type { BenchPosture } from "../../knobs-bench"
import type { EvalCtx, EvalStep } from "../eval-step"

/** The repro gate predicate, exported so the parity test asserts against the
 *  EXACT same predicate the driver uses (not a re-spelled copy). */
export const reproGate = (posture: BenchPosture): boolean =>
  posture.reproTestK !== undefined && posture.reproTestK >= 1

export const reproStep: EvalStep = {
  id: "repro",
  gate: reproGate,
  run: async (ctx: EvalCtx): Promise<EvalCtx> => {
    const delegate = ctx.deps.repro
    if (delegate === undefined) {
      throw new Error("reproStep: gated in but no `deps.repro` delegate bound (wiring error)")
    }
    const source = await delegate()
    if (source === undefined) return ctx
    return foldState(ctx, { reproSource: source })
  },
}
