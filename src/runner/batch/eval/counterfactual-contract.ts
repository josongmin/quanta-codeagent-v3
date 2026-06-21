/**
 * Counterfactual contract derivation + evaluation (T-301).
 *
 * When candidate 0 trips structural risk, candidate 1 is generated from a
 * counterfactual seed that imposes STRUCTURAL CONTRACTS (single owner file, no
 * new defs, no new files, no runtime expansion, non-empty patch). The selector must PENALIZE a
 * counterfactual candidate that violates its OWN contract.
 *
 * This is deliberately NOT a global hard reject: contracts bind ONLY the
 * counterfactual candidate, and only on the exact dimensions that cand0 actually
 * violated. A legitimately-large patch from a NORMAL (non-counterfactual)
 * candidate derives `[]` contracts here and is therefore always satisfied — the
 * key invariant that keeps the patch-budget escalation path (NOT a hard reject)
 * intact for ordinary candidates.
 *
 * Source of truth for cand0's violations: {@link CandidateRiskFacts}
 * (`@/runner/batch/eval/counterfactual-risk`). Source of truth for the
 * counterfactual candidate's own structure: {@link PatchBudgetVerdict}
 * (`@/agent/patch-budget`). PURE + deterministic — no reason-string parsing.
 */

import type { PatchBudgetVerdict } from "@/agent/patch-budget"
import type { CandidateRiskFacts } from "@/runner/batch/eval/counterfactual-risk"

export type CounterfactualContractKind =
  | "singleOwnerFile"
  | "noNewDefs"
  | "noNewFiles"
  | "noRuntimeExpansion"
  | "nonEmptyPatch"

/** Derive the contracts cand1 must honor, from cand0's risk facts.
 *  Only emit a contract for a dimension cand0 actually violated. */
export const deriveCounterfactualContracts = (
  facts: CandidateRiskFacts,
): readonly CounterfactualContractKind[] => {
  const contracts: CounterfactualContractKind[] = []
  if (facts.crossFile || facts.touchedSourceFiles > 1 || facts.filesOutsideOwner.length > 0)
    contracts.push("singleOwnerFile")
  if (facts.newDefs > 0) contracts.push("noNewDefs")
  if (facts.newFiles > 0) contracts.push("noNewFiles")
  if (facts.runtimeExpandingCalls > 0) contracts.push("noRuntimeExpansion")
  if (facts.emptyPatch === true) contracts.push("nonEmptyPatch")
  return contracts
}

export interface CounterfactualContractEvaluation {
  /** true ⇒ candidate honored every derived contract (or no contracts derived). */
  readonly satisfied: boolean
  readonly violations: readonly CounterfactualContractKind[]
}

/** Evaluate a counterfactual candidate's OWN patch against the derived contracts.
 *  Only the derived `contracts` are checked: an undriven dimension never violates. */
export const evaluateCounterfactualContracts = (args: {
  readonly contracts: readonly CounterfactualContractKind[]
  readonly verdict: PatchBudgetVerdict // analyzePatchBudget(candidate1.patch, {ownerFiles})
  readonly emptyPatch: boolean
  /** Repo-relative files the candidate patch touched. Used only to bind the
   *  single-owner-file contract to the EXACT owner file that seeded cand1. */
  readonly candidateFiles?: readonly string[]
  /** The concrete owner file the counterfactual seed targeted. Undefined keeps
   *  the older "any one owner file" interpretation. */
  readonly targetOwnerFile?: string
}): CounterfactualContractEvaluation => {
  const b = args.verdict.budget
  const violates = (kind: CounterfactualContractKind): boolean => {
    switch (kind) {
      case "singleOwnerFile":
        if (b.sourceFiles > 1 || b.filesOutsideOwner.length > 0) return true
        return (
          args.targetOwnerFile !== undefined &&
          !(args.candidateFiles ?? []).includes(args.targetOwnerFile)
        )
      case "noNewDefs":
        return b.newDefs > 0
      case "noNewFiles":
        return b.newFiles > 0
      case "noRuntimeExpansion":
        return b.runtimeExpandingCalls > 0
      case "nonEmptyPatch":
        return args.emptyPatch === true
    }
  }
  const violations = args.contracts.filter(violates)
  return { satisfied: violations.length === 0, violations }
}
