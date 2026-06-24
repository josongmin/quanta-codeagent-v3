/**
 * Knob: `spec-fidelity-invariant` (T2b, jun-24 scaffold SOTA absorption,
 * astropy-13033 class). When the issue declares a concrete expected output
 * (extractIssueDeclaredExpected returns a value), wire a PUBLIC-issue-text
 * declared-expected port into selection so the EXISTING
 * `hard:declaredExpectedMatch=false` veto may fire in CLEAN mode against a
 * candidate that invents a different message shape (passes its own self-made
 * repro but contradicts the public spec).
 *
 * This is NOT a new gate. The veto, the matcher seam, and the extractor already
 * exist; clean mode disabled the gate because its only authority source was the
 * answer-key matcher. This knob supplies the missing CLEAN-LEGITIMATE source —
 * an invariant derived ONLY from public problem text (answer-key guard in
 * buildPublicDeclaredExpectedPort refuses any non-public provenance).
 *
 * Default-OFF. NOOP-apply registry entry: the EFFECT is delivered out of band by
 * the bench driver via `benchPostureFromState` projection (`specFidelityInvariant`
 * field) — the public declared-expected port is wired in the live selection
 * executor ONLY when this knob is on AND a concrete spec was extracted. Presets
 * are NOT touched; the experiment opens via env override only. Promotion still
 * requires the frozen-slice A/B in the promotion protocol; a losing knob is
 * deleted, not left as a permanent research flag. Strict truthy gate:
 * `"1"`/`"on"`/`"true"` ⇒ enabled.
 */

import type { AgentConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]
const ENABLING = new Set(["1", "on", "true"])

const parseSpecFidelityInvariant = (raw: string | undefined): true | undefined => {
  if (raw === undefined) return undefined
  return ENABLING.has(raw.trim().toLowerCase()) ? true : undefined
}

const applySpecFidelityInvariant = (cfg: AgentConfig): AgentConfig => cfg

export const specFidelityInvariantKnob: Knob<true> = {
  id: "spec-fidelity-invariant",
  envKey: "QUANTA_BENCH_SPEC_FIDELITY_INVARIANT",
  category: "tool",
  surfaces: SURFACES,
  parse: parseSpecFidelityInvariant,
  apply: applySpecFidelityInvariant,
  describe:
    "T2b spec-fidelity invariant (public-issue-text declared-expected veto in clean mode; fires only when issue declares an exact expected output)",
  source: "jun-24 scaffold SOTA absorption plan (T2b)",
}

registerKnob(specFidelityInvariantKnob)
