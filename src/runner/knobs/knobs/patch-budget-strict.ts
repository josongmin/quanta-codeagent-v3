/**
 * Knob: `patch-budget-strict` — hard minimal-edit admission.
 *
 * Companion to observe-only `patch-budget`. ON means an over-budget final patch
 * is NOT submitted to the official grader; the runner returns an empty patch and
 * records the PatchBudget verdict when observing. Intended shape:
 * mini-first, source-only, patch-budgeted, critic/select late.
 */

import type { AgentConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]

const parsePatchBudgetStrict = (raw: string | undefined): true | undefined => {
  if (raw === undefined) return undefined
  return raw === "1" || raw === "on" || raw === "true" ? true : undefined
}

const applyPatchBudgetStrict = (cfg: AgentConfig): AgentConfig => cfg

export const patchBudgetStrictKnob: Knob<true> = {
  id: "patch-budget-strict",
  envKey: "QUANTA_BENCH_PATCH_BUDGET_STRICT",
  category: "validation",
  surfaces: SURFACES,
  parse: parsePatchBudgetStrict,
  apply: applyPatchBudgetStrict,
  describe: "Hard minimal-edit admission: block over-budget final patches from submission",
  source: "jun-20 SOTA++ strict minimal-edit admission",
}

registerKnob(patchBudgetStrictKnob)
