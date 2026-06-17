/**
 * Knob: `verification-plan` (T-301) — build a typed `VerificationPlan` (primary
 * rail + required/optional steps, each required step carrying a typed
 * `successPredicate`) instead of relying on whatever verify-like command the
 * agent happened to run.
 *
 * Default-OFF. NOOP-apply registry entry: the EFFECT is delivered out of band by
 * the bench driver via `benchPostureFromState` projection (`verificationPlan`
 * field). Strict truthy gate: `"1"`/`"on"`/`"true"` ⇒ enabled.
 */

import type { AgentConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]
const ENABLING = new Set(["1", "on", "true"])

const parseVerificationPlan = (raw: string | undefined): true | undefined => {
  if (raw === undefined) return undefined
  return ENABLING.has(raw.trim().toLowerCase()) ? true : undefined
}

const applyVerificationPlan = (cfg: AgentConfig): AgentConfig => cfg

export const verificationPlanKnob: Knob<true> = {
  id: "verification-plan",
  envKey: "QUANTA_BENCH_VERIFICATION_PLAN",
  category: "tool",
  surfaces: SURFACES,
  parse: parseVerificationPlan,
  apply: applyVerificationPlan,
  describe: "T-301 typed VerificationPlan (primary rail + typed successPredicates)",
  source: "jun-17 proof-driven bench closure (T-301)",
}

registerKnob(verificationPlanKnob)
