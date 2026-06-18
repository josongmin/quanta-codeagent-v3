import type { OwnerAdmission } from "@/agent/owner-admission"

export const renderClosurePrompt = (owner: OwnerAdmission): string => {
  if (!owner.admit || owner.owner === null) return ""
  if (owner.coverageExpectation !== "single-site") return ""
  return `First edit candidate: ${owner.owner}`
}
