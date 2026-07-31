/**
 * v5 adaptive-escalation PHASE EXECUTOR PORT FACTORY (jun-22 Wave-3 seam).
 *
 * `runAdaptiveEscalation` (controller.ts) drives the bounded loop and, for each
 * admitted non-terminal action, calls its injected `executor` port:
 *   `(input: AdaptiveExecutorInput<RouterEvidence>) => Promise<{ packet: RouterEvidence }>`
 * The executor must run the action's mapped PHASE and return a FRESH router
 * evidence read-model RE-derived from whatever that phase actually produced (so
 * the next route sees post-phase evidence, never the stale pre-phase packet).
 *
 * This factory builds that port from INJECTED dependencies, so the whole loop
 * stays hermetically testable with fakes and free of any LLM / driver coupling:
 *
 *   - `base`      — the run's resolved {@link BenchKnobState}, captured ONCE at
 *                   run start (the thin base every phase posture folds onto).
 *   - `env`       — the process env snapshot the posture projector reads.
 *   - `runPhase`  — the INJECTED phase runner. The REAL one (wired at Wave-3
 *                   integration) runs an actual driver phase with the supplied
 *                   per-phase {@link BenchKnobState}+{@link BenchPosture} and
 *                   returns the resulting {@link LlmEvidencePacket}; tests
 *                   inject a fake.
 *
 * The executor is a pure 3-step pipeline over those ports:
 *   (1) `state = withKnobModules(base, input.modules)` and
 *       `posture = derivePhasePosture(base, input.modules, env)` — fold the
 *       action's capability modules onto the base and re-derive a consistent
 *       posture through the canonical projector (modules=[] ⇒ posture==base).
 *   (2) `{ packet } = await runPhase({ action, state, posture })` — run the phase.
 *   (3) `return { packet: projectRouterEvidence(packet) }` — re-project the FRESH
 *       packet into the router read-model (blindness re-enforced at render time).
 *
 * INTEGRATION CONTRACT (what the driver's real `runPhase` must do): execute one
 * phase under the GIVEN injected state+posture (not a re-resolved preset from
 * env) and return the post-phase `LlmEvidencePacket`. This is the missing
 * per-phase injection point the posture seam (`posture/knob-module.ts`) flagged:
 * the driver entrypoints must accept the injected posture instead of calling
 * `benchOptIns()`, and the SAME derived `BenchKnobState` must feed report
 * serialization, `knobs_applied`, and agent config (the "report ≠ applied"
 * fidelity obligation lives at that wiring, not here).
 */

import type { BenchKnobState, BenchPosture } from "../knobs-bench"
import type { LlmEvidencePacket } from "../llm-evidence-packet"
import { type AdaptiveAction, derivePhasePosture, withKnobModules } from "../posture"
import type { AdaptiveExecutorInput } from "./controller"
import { projectRouterEvidence, type RouterEvidence } from "./router-evidence"

/** The INJECTED phase runner: run one phase under `state` + `posture`, return
 *  its packet. The real implementation is wired to the driver at Wave-3
 *  integration; tests inject a fake that records the injected config and
 *  returns a fixture packet. */
export type RunPhasePort = (args: {
  readonly action: AdaptiveAction
  readonly state: BenchKnobState
  readonly posture: BenchPosture
}) => Promise<{ readonly packet: LlmEvidencePacket }>

/** Hermetic dependencies for {@link makeAdaptiveExecutor}. */
export interface AdaptiveExecutorDeps {
  /** Resolved base knob state, captured ONCE at run start. */
  readonly base: BenchKnobState
  /** Process env snapshot the posture projector reads. */
  readonly env: NodeJS.ProcessEnv
  /** Injected phase runner (real ⇒ driver; tests ⇒ fake). */
  readonly runPhase: RunPhasePort
}

/**
 * Build the controller's `executor` port from injected deps. The returned port:
 *   (1) derives the per-phase state+posture for the action's modules,
 *   (2) runs the injected phase runner with that config,
 *   (3) re-projects the FRESH packet through `projectRouterEvidence`.
 */
export const makeAdaptiveExecutor =
  (deps: AdaptiveExecutorDeps) =>
  async (
    input: AdaptiveExecutorInput<RouterEvidence>,
  ): Promise<{ readonly packet: RouterEvidence }> => {
    const state = withKnobModules(deps.base, input.modules)
    const posture = derivePhasePosture(deps.base, input.modules, deps.env)
    const { packet } = await deps.runPhase({ action: input.action, state, posture })
    return { packet: projectRouterEvidence(packet) }
  }
