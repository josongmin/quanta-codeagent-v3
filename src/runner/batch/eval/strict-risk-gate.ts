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

const addedLines = (patch: string): string[] =>
  patch
    .split(/\r?\n/)
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))

const AXIS_ISSUE_RE =
  /\b(axis|axes|xlim|ylim|x[- ]?axis|y[- ]?axis|invert(?:ed|s|ing)?|grid|categorical|nominal|limits?)\b/i
const BOTH_AXES_RE =
  /\b(?:both\s+(?:axes|axis|x\s*(?:and|\/|&)\s*y)|x\s*(?:and|\/|&)\s*y|y\s*(?:and|\/|&)\s*x|x[- ]?axis[\s\S]{0,120}y[- ]?axis|y[- ]?axis[\s\S]{0,120}x[- ]?axis)\b/i
const PATCH_X_AXIS_RE = /\b(set_xlim|get_xlim|xlim|xaxis|xticks|get_xticks)\b|axis\s*==\s*["']x["']/i
const PATCH_Y_AXIS_RE =
  /\b(set_ylim|get_ylim|ylim|yaxis|yticks|get_yticks|invert_yaxis)\b|axis\s*==\s*["']y["']/i
const EXPLICIT_LIMIT_ISSUE_RE =
  /\b(?:explicit|preserve|respect|user[- ]?specified|already\s+set|existing)\b[\s\S]{0,120}\b(?:limits?|xlim|ylim)\b|\b(?:limits?|xlim|ylim)\b[\s\S]{0,120}\b(?:explicit|preserve|respect|user[- ]?specified|already\s+set|existing)\b/i
const EXPLICIT_LIMIT_PATCH_RE =
  /\b(auto\s*=\s*None|get_xlim|get_ylim|preserv|explicit|existing|already\s+set)\b/i

const hasAxisInversionLimitOrderRisk = (added: string): boolean => {
  if (!/\binvert_yaxis\s*\(/.test(added)) return false
  const invertIndex = added.search(/\binvert_yaxis\s*\(/)
  const afterInvert = added.slice(invertIndex)
  const genericAscendingLimit =
    /(?:\{axis\}lim|axis\}\s*lim|f["']\{axis\}lim|set\s*\(\s*\*\*\{[\s\S]{0,120}axis[\s\S]{0,80}lim)[\s\S]{0,240}\(\s*-\s*\.?5\s*,\s*(?:n\s*-\s*\.?5|len\s*\(|[A-Za-z_][\w.]*)/i.test(
      afterInvert,
    )
  const directAscendingYLimit = /\bset_ylim\s*\(\s*-\s*\.?5\s*,/.test(afterInvert)
  return genericAscendingLimit || directAscendingYLimit
}

const semanticReasons = (problemStatement: string, patch: string): string[] => {
  const issue = problemStatement.toLowerCase()
  const added = addedLines(patch).join("\n")
  const reasons: string[] = []
  if (added.trim() === "") {
    reasons.push("empty-patch")
    return reasons
  }
  if (AXIS_ISSUE_RE.test(issue) && BOTH_AXES_RE.test(issue)) {
    if (!PATCH_X_AXIS_RE.test(added) || !PATCH_Y_AXIS_RE.test(added)) {
      reasons.push("axis-both-sides-not-evidenced")
    }
  }
  if (AXIS_ISSUE_RE.test(issue) && hasAxisInversionLimitOrderRisk(added)) {
    reasons.push("axis-inversion-overwritten-by-ascending-limit")
  }
  if (EXPLICIT_LIMIT_ISSUE_RE.test(issue) && !EXPLICIT_LIMIT_PATCH_RE.test(added)) {
    reasons.push("explicit-limit-preservation-not-evidenced")
  }
  return reasons
}

export const evaluateStrictPatchRisk = (input: StrictRiskGateInput): StrictRiskGateDecision => {
  const patchBudget = analyzePatchBudget(input.patch, {
    ownerFiles: input.ownerFiles ?? [],
    ...(input.repo !== undefined ? { repo: input.repo } : {}),
    runtimeExpandingPolicy: "gate",
  })
  const reasons = [
    ...patchBudget.overBudgetReasons.map((reason) => `patch-budget:${reason}`),
    ...semanticReasons(input.problemStatement, input.patch),
  ]
  return {
    expand: reasons.length > 0,
    reasons,
    patchBudget,
  }
}
