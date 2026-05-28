import type {
  GroundingCase,
  GroundingDecision,
  GroundingNormalizationProfile,
} from "./schema"
import {
  normalizeGroundingDecisionHeuristically,
  type GroundingNormalizationPassResult as HeuristicPassResult,
} from "./normalization/heuristic"
import {
  normalizeGroundingDecisionStructurally,
  type GroundingNormalizationPassResult as StructuralPassResult,
} from "./normalization/structural"

export interface GroundingNormalizationResult {
  decision: GroundingDecision
  applied: boolean
  reasons: readonly string[]
}

const mergePasses = (
  first: StructuralPassResult,
  second: HeuristicPassResult | undefined,
): GroundingNormalizationResult => {
  if (second === undefined) {
    return {
      decision: first.decision,
      applied: first.applied,
      reasons: first.reasons,
    }
  }
  return {
    decision: second.decision,
    applied: first.applied || second.applied,
    reasons: [...new Set([...first.reasons, ...second.reasons])],
  }
}

export const normalizeGroundingDecision = (
  groundingCase: GroundingCase,
  decision: GroundingDecision,
  profile: GroundingNormalizationProfile = "heuristic",
): GroundingNormalizationResult => {
  if (profile === "none") {
    return {
      decision,
      applied: false,
      reasons: [],
    }
  }
  const structural = normalizeGroundingDecisionStructurally(groundingCase, decision)
  if (profile === "structural") return structural
  const heuristic = normalizeGroundingDecisionHeuristically(groundingCase, structural.decision)
  return mergePasses(structural, heuristic)
}
