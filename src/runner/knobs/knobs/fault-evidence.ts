/**
 * Knob: `fault-evidence` (T-201) — emit a bounded typed `FaultEvidencePacket`
 * (owner-context: paths/symbols only, no raw source) into the bench loop instead
 * of raw-source hint blobs.
 *
 * Default-OFF. NOOP-apply registry entry: the EFFECT is delivered out of band by
 * the bench driver via `benchPostureFromState` projection (`faultEvidence`
 * field) + `buildConfig`. Exists here so the resolver / report / preset layer
 * can SEE the knob. Strict truthy gate: `"1"`/`"on"`/`"true"` ⇒ enabled.
 */

import type { AgentConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]
const ENABLING = new Set(["1", "on", "true"])

const parseFaultEvidence = (raw: string | undefined): true | undefined => {
  if (raw === undefined) return undefined
  return ENABLING.has(raw.trim().toLowerCase()) ? true : undefined
}

const applyFaultEvidence = (cfg: AgentConfig): AgentConfig => cfg

export const faultEvidenceKnob: Knob<true> = {
  id: "fault-evidence",
  envKey: "QUANTA_BENCH_FAULT_EVIDENCE",
  category: "tool",
  surfaces: SURFACES,
  parse: parseFaultEvidence,
  apply: applyFaultEvidence,
  describe: "T-201 typed FaultEvidencePacket (bounded owner-context, no raw source)",
  source: "jun-17 proof-driven bench closure (T-201)",
}

registerKnob(faultEvidenceKnob)
