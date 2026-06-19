/**
 * Knob: `patch-budget` — minimal-edit admission (jun-19, #13417 class).
 *
 * Computes the typed PatchBudget over the final diff (source files / new files /
 * new def-class / cross-file vs owner). Default-OFF ⇒ byte-identical. ON ⇒ the
 * driver emits the budget telemetry (over_budget_rate / new_def_rate /
 * cross_file_rate, feeding the A/B); the SOFT-WITH-ESCALATION admission (route
 * over-budget to the late critic) is a later measure-first step — observe first.
 *
 * APPLY IS A NOOP — consumed out of band by the bench driver (observe block),
 * not stored on AgentConfig. Registry status required for resolver/report/preset.
 */

import type { AgentConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]

const parsePatchBudget = (raw: string | undefined): boolean | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim().toLowerCase()
  if (s === "" || s === "0" || s === "off" || s === "false") return undefined
  return true
}

const applyPatchBudget = (cfg: AgentConfig): AgentConfig => cfg

export const patchBudgetKnob: Knob<boolean> = {
  id: "patch-budget",
  envKey: "QUANTA_BENCH_PATCH_BUDGET",
  category: "validation",
  surfaces: SURFACES,
  parse: parsePatchBudget,
  apply: applyPatchBudget,
  describe: "Minimal-edit admission: emit PatchBudget over the diff (#13417 over-engineer class)",
  source: "jun-19 minimal-patch admission (Agentless 3-phase / mini-SWE thin scaffold)",
}

registerKnob(patchBudgetKnob)
