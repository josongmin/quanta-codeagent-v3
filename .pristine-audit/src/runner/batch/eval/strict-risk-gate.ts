import { analyzePatchBudget, type PatchBudgetVerdict } from "@/agent/patch-budget"

export interface StrictRiskGateInput {
  readonly patch: string
  readonly problemStatement: string
  readonly ownerFiles?: readonly string[]
  readonly repo?: string
}

export interface StrictRiskGateDecision {
  /** True means spend the next strict candidate and let late selection decide. */
  readonly expand: boolean
  /** Stable machine-readable reasons for telemetry and A/B attribution. */
  readonly reasons: readonly string[]
  /** Patch-budget fact set used by the gate. Not fed back to the model. */
  readonly patchBudget: PatchBudgetVerdict
}

const strictSourceFileBudgetReason = (patchBudget: PatchBudgetVerdict): string | null => {
  const touched = patchBudget.budget.sourceFiles
  if (touched <= 1) return null
  return `source-file budget=1 (strict candidate touched ${touched} source files)`
}

export const evaluateStrictPatchRisk = (input: StrictRiskGateInput): StrictRiskGateDecision => {
  const patchBudget = analyzePatchBudget(input.patch, {
    ownerFiles: input.ownerFiles ?? [],
    ...(input.repo !== undefined ? { repo: input.repo } : {}),
    runtimeExpandingPolicy: "gate",
  })
  const reasons = patchBudget.overBudgetReasons.map((reason) => `patch-budget:${reason}`)
  const sourceFileBudgetReason = strictSourceFileBudgetReason(patchBudget)
  if (sourceFileBudgetReason !== null) reasons.push(`patch-budget:${sourceFileBudgetReason}`)
  if (input.patch.trim() === "") reasons.push("empty-patch")
  return {
    expand: reasons.length > 0,
    reasons,
    patchBudget,
  }
}
