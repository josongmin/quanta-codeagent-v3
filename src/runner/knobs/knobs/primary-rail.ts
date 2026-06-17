/**
 * Knob: `primary-rail` (T-302) — enforce the planner-selected primary rail as the
 * gate that clears "done": a NON-primary green must NOT clear the gate, repair
 * iterates only while the primary rail is RED, and the commit-vs-verify gate is
 * categorical. Closes the false-green hole where the repair validator cleared on
 * the agent's own verify command.
 *
 * Default-OFF. NOOP-apply registry entry: the EFFECT is delivered out of band by
 * the bench driver via `benchPostureFromState` projection (`primaryRail` field).
 * Strict truthy gate: `"1"`/`"on"`/`"true"` ⇒ enabled.
 */

import type { AgentConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]
const ENABLING = new Set(["1", "on", "true"])

const parsePrimaryRail = (raw: string | undefined): true | undefined => {
  if (raw === undefined) return undefined
  return ENABLING.has(raw.trim().toLowerCase()) ? true : undefined
}

const applyPrimaryRail = (cfg: AgentConfig): AgentConfig => cfg

export const primaryRailKnob: Knob<true> = {
  id: "primary-rail",
  envKey: "QUANTA_BENCH_PRIMARY_RAIL",
  category: "tool",
  surfaces: SURFACES,
  parse: parsePrimaryRail,
  apply: applyPrimaryRail,
  describe: "T-302 primary-rail enforcement + commit-vs-verify gate + repair admission",
  source: "jun-17 proof-driven bench closure (T-302)",
}

registerKnob(primaryRailKnob)
