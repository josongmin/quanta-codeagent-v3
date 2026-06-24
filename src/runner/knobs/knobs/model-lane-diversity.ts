/**
 * Knob: `model-lane-diversity` (G1, jun-24 scaffold SOTA absorption).
 *
 * verify-and-select generates N candidates AND scores them through the SAME LLM
 * port (one vendor/family, e.g. gpt-5.4). N parallel samples of one model are
 * heavily CORRELATED — the measured "synthesis 74%" failure is the whole
 * candidate set landing on the same wrong anchor TOGETHER (diversity ≈ 0). The
 * only diversity verify-select had was `seeds[i]` (a fix-SITE nudge), not a
 * DIFFERENT generator.
 *
 * When ON, the bench driver routes candidate `i` to vendor LANE `i mod V` over
 * the injected `deps.llmLanes` (a small ordered list of provider-distinct
 * `LLMPort`s, built from the existing `createLLM` adapters — NO new transport).
 * So cand0 might be served by anthropic, cand1 by openai, decorrelating the
 * generation set; the selector then picks across vendors instead of across N
 * copies of one model. The lane resolution is `resolveLaneLlm`
 * (driver.ts), and `buildConfig` reads the resolved lane port at the wire site
 * (`laneLlm ?? deps.llm`), so this is a REAL provider swap, not a tag.
 *
 * No answer-key: lane selection is `index mod laneCount` — pure structure, no
 * issue/gold inspection. Default-OFF (knob unset OR `deps.llmLanes` length ≤ 1 ⇒
 * every candidate stays on `deps.llm`, byte-identical single-vendor path). NOOP-
 * apply registry entry: the EFFECT is delivered out of band by the driver via
 * the `benchPostureFromState` projection (`modelLaneDiversity` field). A losing
 * knob is deleted, not left as a permanent research flag. Strict truthy gate:
 * `"1"`/`"on"`/`"true"` ⇒ enabled.
 */

import type { AgentConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]
const ENABLING = new Set(["1", "on", "true"])

const parseModelLaneDiversity = (raw: string | undefined): true | undefined => {
  if (raw === undefined) return undefined
  return ENABLING.has(raw.trim().toLowerCase()) ? true : undefined
}

const applyModelLaneDiversity = (cfg: AgentConfig): AgentConfig => cfg

export const modelLaneDiversityKnob: Knob<true> = {
  id: "model-lane-diversity",
  envKey: "QUANTA_BENCH_MODEL_LANE_DIVERSITY",
  category: "tool",
  surfaces: SURFACES,
  parse: parseModelLaneDiversity,
  apply: applyModelLaneDiversity,
  describe:
    "G1 model-lane-diversity: route verify-select candidate i to vendor lane (i mod V) over the injected provider-distinct LLM lanes, decorrelating the candidate set so the selector picks across vendors/families instead of N copies of one model (occupies the dual-provider generate seam; NOOP-apply, effect via benchPostureFromState)",
  source: "jun-24 scaffold SOTA absorption plan (G1 cross-vendor diversity)",
}

registerKnob(modelLaneDiversityKnob)
