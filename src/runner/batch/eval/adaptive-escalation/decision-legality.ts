import type { AdaptiveDecision } from "./decision-schema"
import type { EvidenceFacts } from "./evidence-facts"

/**
 * Semantic legality checks for router actions that the JSON schema cannot
 * express. Fail-closed: an illegal action is treated like bad router output and
 * never executes.
 */
export const validateAdaptiveDecisionForEvidence = (
  facts: EvidenceFacts,
  decision: AdaptiveDecision,
): string | undefined => {
  const lacksProofContext =
    !facts.baseReproEstablished && facts.declaredConditionEvidenced !== true
  switch (decision.action) {
    case "run_public_repro": {
      if (facts.infraBlocked) return "run_public_repro_while_infra_blocked"
      if (facts.baseReproEstablished) return "run_public_repro_after_base_repro"
      return undefined
    }
    case "run_proof_clean": {
      if (facts.positiveProof) return "run_proof_clean_after_positive_proof"
      if (facts.infraBlocked) return "run_proof_clean_while_infra_blocked"
      if (lacksProofContext) return "run_proof_clean_without_proof_context"
      return undefined
    }
    case "repair_with_proof": {
      if (facts.positiveProof) return "repair_with_proof_after_positive_proof"
      if (facts.infraBlocked) return "repair_with_proof_while_infra_blocked"
      if (lacksProofContext) {
        return "repair_with_proof_without_proof_context"
      }
      return undefined
    }
    default:
      return undefined
  }
}
