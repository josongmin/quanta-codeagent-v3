import { analyzePatchBudget, type PatchBudgetVerdict } from "@/agent/patch-budget"
import { type AdmissionBlock, PATCH_BUDGET_STRICT_ADMISSION_KIND } from "@/runner/batch/admission"
import type { InstanceResult } from "@/runner/batch/types"
import type { ClosureSessionState } from "./closure-session"

export const buildPhasePatchBudget = (args: {
  readonly patch: string
  readonly repo: string | undefined
  readonly closureSession: ClosureSessionState | undefined
  readonly strict: boolean
}): PatchBudgetVerdict =>
  analyzePatchBudget(args.patch, {
    ownerFiles: args.closureSession?.bundle.evidence.candidates.map((c) => c.file) ?? [],
    ...(args.repo !== undefined ? { repo: args.repo } : {}),
    runtimeExpandingPolicy: args.strict ? "gate" : "observe",
  })

export const patchBudgetBlockMessage = (verdict: PatchBudgetVerdict): string =>
  `patch budget exceeded: ${verdict.overBudgetReasons.join("; ")}`

export const strictPatchBudgetAdmissionBlock = (): AdmissionBlock => ({
  kind: PATCH_BUDGET_STRICT_ADMISSION_KIND,
})

type StrictPatchBudgetBlockedExtra = Omit<
  Partial<InstanceResult>,
  "id" | "passed" | "patch" | "turns" | "error" | "admissionBlock"
>

export const buildStrictPatchBudgetBlockedResult = (args: {
  readonly id: string
  readonly turns: number
  readonly verdict: PatchBudgetVerdict
  readonly extra?: StrictPatchBudgetBlockedExtra
}): InstanceResult => ({
  id: args.id,
  passed: false,
  patch: "",
  turns: args.turns,
  ...(args.extra ?? {}),
  error: patchBudgetBlockMessage(args.verdict),
  admissionBlock: strictPatchBudgetAdmissionBlock(),
})
