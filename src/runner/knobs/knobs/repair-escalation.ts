/**
 * Knob: `repair-escalation` (T-601) — explicit `RepairEscalationDecision`
 * (continue-single-owner / collect-more-evidence / branch-search /
 * multi-owner-plan) derived from the typed artifacts, with a closed structured
 * reason taxonomy. Widen to multi-site ONLY on explicit cross-owner evidence.
 *
 * Default-OFF. NOOP-apply registry entry: the EFFECT is delivered out of band by
 * the bench driver via `benchPostureFromState` projection (`repairEscalation`
 * field). Strict truthy gate: `"1"`/`"on"`/`"true"` ⇒ enabled.
 */

import type { AgentConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]
const ENABLING = new Set(["1", "on", "true"])

const parseRepairEscalation = (raw: string | undefined): true | undefined => {
  if (raw === undefined) return undefined
  return ENABLING.has(raw.trim().toLowerCase()) ? true : undefined
}

const applyRepairEscalation = (cfg: AgentConfig): AgentConfig => cfg

export const repairEscalationKnob: Knob<true> = {
  id: "repair-escalation",
  envKey: "QUANTA_BENCH_REPAIR_ESCALATION",
  category: "tool",
  surfaces: SURFACES,
  parse: parseRepairEscalation,
  apply: applyRepairEscalation,
  describe: "T-601 multi-owner escalation decision (closed reason taxonomy)",
  source: "jun-17 proof-driven bench closure (T-601)",
}

registerKnob(repairEscalationKnob)
