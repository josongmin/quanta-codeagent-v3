/**
 * Adaptive-escalation ASSEMBLED RUNNER (jun-22 v5 Wave-3, group D — the keystone
 * that ties the controller + both ports + the evidence projection into ONE
 * callable entry).
 *
 * The Wave-1 controller (`runAdaptiveEscalation`) is generic over injected
 * router/executor ports; Wave-3 built the two real port FACTORIES (`makeLlmRouter`,
 * `makeAdaptiveExecutor`). This module is the single place that ASSEMBLES them so
 * the bench driver has exactly one thing to call (`runAdaptiveBenchAttempt`) and
 * no caller re-wires the ports by hand (which would re-introduce drift). It is
 * the seam the gated driver branch invokes.
 *
 * # Hermetic by construction
 * Every side-effecting dependency is injected (`modelCall` = the LLM seam,
 * `runPhase` = the driver phase seam), so the whole assembly — projection →
 * route → admit → execute → re-project — is unit-testable with fakes and free of
 * any LLM / driver / fs coupling. Wave-3 integration supplies the real
 * `modelCall` (LLMPort + StructuredOutput adapter) and `runPhase` (a driver phase
 * under the injected posture); the gate (`v5AdaptiveEnabled` /
 * `QUANTA_BENCH_V5_ADAPTIVE`, default-OFF) decides whether the driver calls this
 * at all.
 *
 * # Authority fence preserved
 * The router port returns raw model output; the controller validates it
 * fail-closed (`parseAdaptiveDecision`) and any invalid output becomes
 * escalate-needs-human — never a silent submit. Submit authority stays with the
 * executed-proof / clean-selector rails inside each executed phase. This runner
 * only chooses WHICH phase runs, bounded by `DEFAULT_ADAPTIVE_LIMITS`.
 */

import type { BenchKnobState } from "../knobs-bench"
import type { LlmEvidencePacket } from "../llm-evidence-packet"
import { type AdaptiveRunResult, runAdaptiveEscalation } from "./controller"
import { evidenceIdsOf } from "./evidence-facts"
import { type AdaptiveModelCall, makeLlmRouter } from "./llm-router"
import { makeAdaptiveExecutor, type RunPhasePort } from "./phase-executor"
import { projectRouterEvidence, type RouterEvidence } from "./router-evidence"
import type { AdaptiveLimits } from "./transitions"

/** Everything the assembled adaptive run needs, all injected (hermetic). */
export interface AdaptiveRunDeps {
  /** The intake evidence packet (the run's first, pre-phase evidence). */
  readonly intakePacket: LlmEvidencePacket
  /** The run's resolved base knob state, captured ONCE at run start. */
  readonly base: BenchKnobState
  /** Process env snapshot the posture projector reads. */
  readonly env: NodeJS.ProcessEnv
  /** The LLM seam (LLMPort + StructuredOutput adapter); injected for hermeticity. */
  readonly modelCall: AdaptiveModelCall
  /** The driver phase seam: run one phase under the injected posture → packet. */
  readonly runPhase: RunPhasePort
  /** Override the router model id. */
  readonly model?: string
  /** Override the router max output tokens. */
  readonly maxTokens?: number
  /** Override the bounded transition limits (default: DEFAULT_ADAPTIVE_LIMITS). */
  readonly limits?: AdaptiveLimits
}

/**
 * Run one adaptive-escalation attempt: project the intake packet into the router
 * read-model, then drive the bounded controller with the assembled router +
 * executor ports. Returns the controller's typed {@link AdaptiveRunResult}
 * (outcome + reason + executed steps + final decision) — the driver maps that
 * onto the bench attempt result and the report.
 */
export const runAdaptiveBenchAttempt = (deps: AdaptiveRunDeps): Promise<AdaptiveRunResult> =>
  runAdaptiveEscalation<RouterEvidence>({
    initialPacket: projectRouterEvidence(deps.intakePacket),
    citableIds: (re) => evidenceIdsOf(re.facts),
    router: makeLlmRouter({
      call: deps.modelCall,
      ...(deps.model !== undefined ? { model: deps.model } : {}),
      ...(deps.maxTokens !== undefined ? { maxTokens: deps.maxTokens } : {}),
    }),
    executor: makeAdaptiveExecutor({ base: deps.base, env: deps.env, runPhase: deps.runPhase }),
    ...(deps.limits !== undefined ? { limits: deps.limits } : {}),
  })
