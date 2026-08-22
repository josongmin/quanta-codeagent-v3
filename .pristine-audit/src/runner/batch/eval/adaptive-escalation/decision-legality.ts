import type { AdaptiveDecision } from "./decision-schema"
import type { EvidenceFacts } from "./evidence-facts"

/**
 * Semantic legality checks for router actions that the JSON schema cannot
 * express. Fail-closed: an illegal action is treated like bad router output and
 * never executes.
 *
 * # Authority fence (jun-25): interpretive vetoes are ADVISORY, not HARD
 *
 * The router LLM picks the next phase having read the FULL evidence packet. The
 * ONLY thing this guard may HARD-veto is a state that is mechanically true from a
 * REAL receipt (no interpretive proxy). Earlier this module also vetoed
 *   - run_proof_clean / repair_with_proof "without proof context", and
 *   - run_public_repro / run_proof_clean "after" a prior state (ordering),
 * forcing the model's chosen EXPENSIVE phase into escalate-needs-human. Those
 * vetoes fired on DERIVED proxies (`lacksProofContext` reads
 * `declaredConditionEvidenced`, itself derived from `primaryRail !== null`; the
 * "after" guards second-guess an ordering the model already weighed). A derived
 * guess must NOT override the model's judgment to enter a phase that might
 * ESTABLISH that very context. So those checks are now SURFACED to the router as
 * advisory EVIDENCE LINES (see `evidence-facts.renderEvidenceFacts` /
 * `router-evidence.projectRouterEvidence`) and removed from the hard veto set.
 *
 * What stays HARD here: `infraBlocked` — and ONLY when it is backed by a real
 * execution-failure receipt (`execution_failed` / `env_prep_failed`), NOT the
 * `missingEvidence public_proof` proxy (which is demoted at the fact-derivation
 * site, `router-evidence.deriveEvidenceFactsFromPacket`). Running an expensive
 * executable phase while the sandbox cannot execute is mechanically futile, so
 * that one veto is legitimate. The bounded-loop budget caps
 * (maxTotalSteps/maxExpensive/maxPerAction) and the fail-closed-on-invalid-OUTPUT
 * parser stay too — those are mechanical, not interpretive.
 */
export const validateAdaptiveDecisionForEvidence = (
  facts: EvidenceFacts,
  decision: AdaptiveDecision,
): string | undefined => {
  switch (decision.action) {
    case "run_public_repro":
      // Executing a public reproduction is futile while the sandbox cannot run
      // (real exec-failure receipt only — see router-evidence derivation).
      if (facts.infraBlocked) return "run_public_repro_while_infra_blocked"
      return undefined
    case "run_proof_clean":
      if (facts.infraBlocked) return "run_proof_clean_while_infra_blocked"
      return undefined
    case "repair_with_proof":
      if (facts.infraBlocked) return "repair_with_proof_while_infra_blocked"
      return undefined
    default:
      return undefined
  }
}
