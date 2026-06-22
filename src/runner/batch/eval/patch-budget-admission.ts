import { analyzePatchBudget, type PatchBudgetVerdict } from "@/agent/patch-budget"
import type { ClosureSessionState } from "./closure-session"

export const patchBudgetOwnerFiles = (
  closureSession: ClosureSessionState | undefined,
): readonly string[] => {
  if (closureSession === undefined) return []
  return [
    ...new Set([
      ...closureSession.bundle.evidence.candidates.map((c) => c.file),
      ...(closureSession.input.evidence.ownerResolved?.map((o) => o.file) ?? []),
    ]),
  ]
}

export const buildPhasePatchBudget = (args: {
  readonly patch: string
  readonly repo: string | undefined
  readonly closureSession: ClosureSessionState | undefined
  readonly strict: boolean
}): PatchBudgetVerdict =>
  analyzePatchBudget(args.patch, {
    ownerFiles: patchBudgetOwnerFiles(args.closureSession),
    ...(args.repo !== undefined ? { repo: args.repo } : {}),
    runtimeExpandingPolicy: args.strict ? "gate" : "observe",
  })

// jun-22: removed the dead `buildStrictPatchBudgetBlockedResult` /
// `strictPatchBudgetAdmissionBlock` hard-veto builders. They discarded the
// agent's real patch and returned an empty one when a patch was "over-budget" —
// unwired jun-21 (it zeroed legitimate fixes, e.g. pytest-5787) but left as a
// re-wirable footgun. Patch-budget is soft-escalation only; there is no hard
// reject. (The admission-block READ side stays defensive but is now never
// produced.)
