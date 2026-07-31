/**
 * Hellgate for the v5 adaptive-escalation router contract + bounded controller
 * (jun-22 Wave-1 skeleton). The router lets the LLM pick a PHASE, never a knob
 * or preset; submit authority stays elsewhere. The invariants that MUST hold:
 *
 *   1. Closed schema — an action/gap outside the closed set is rejected.
 *   2. Cited-evidence scope — a cited id absent from the packet is rejected.
 *   3. Fail-closed — any malformed output returns {ok:false}; the caller must
 *      escalate, never submit.
 *   4. No drift — the router's action set is EXACTLY the posture map's keys, so
 *      it can never emit an action the controller can't route (and vice versa).
 *   5. Bounded — the controller cannot loop forever; expensive/per-action/total
 *      caps deny with a typed stop reason.
 */

import { describe, expect, test } from "bun:test"
import {
  ADAPTIVE_ACTIONS,
  ADAPTIVE_DECISION_JSON_SCHEMA,
  type AdaptiveAction,
  type AdaptiveDecision,
  admitNextStep,
  classifyAction,
  DEFAULT_ADAPTIVE_LIMITS,
  EVIDENCE_GAPS,
  type EvidenceFacts,
  fullyEvidencedFacts,
  isExpensiveAction,
  isRerouteAction,
  isTerminalAction,
  parseAdaptiveDecision,
  renderAdvisoryRouterFacts,
  terminalStopReason,
  validateAdaptiveDecisionForEvidence,
} from "@/runner/batch/eval/adaptive-escalation"
import { PHASE_MODULES } from "@/runner/batch/eval/posture"

const IDS = { issueId: "issue", candidateId: "candidate", ownersId: "owners", proofId: "proof" }
/** Facts with NO proof context (the predicate the old hard veto fired on). */
const lacksProofFacts = (): EvidenceFacts => ({
  ...fullyEvidencedFacts(IDS),
  baseReproEstablished: false,
  declaredConditionEvidenced: null,
  positiveProof: false,
})
const dec = (action: AdaptiveAction): AdaptiveDecision => ({
  action,
  evidenceGaps: [],
  citedEvidenceIds: [],
  why: "x",
})

const PACKET_IDS = new Set(["ev:issue", "ev:owner", "ev:repro"])

const validRaw = {
  action: "run_proof_clean",
  evidenceGaps: ["candidate_no_positive_proof"],
  citedEvidenceIds: ["ev:owner"],
  why: "thin candidate has no executed proof; owner evidence suggests a fix site",
}

describe("adaptive-escalation router contract", () => {
  describe("schema parse (closed enums, cited-evidence scope, fail-closed)", () => {
    test("SCHEMA-1: a well-formed decision parses", () => {
      const r = parseAdaptiveDecision(validRaw, PACKET_IDS)
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.decision.action).toBe("run_proof_clean")
    })

    test("SCHEMA-2: an action outside the closed set is REJECTED", () => {
      const r = parseAdaptiveDecision({ ...validRaw, action: "run_everything" }, PACKET_IDS)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toContain("unknown_action")
    })

    test("SCHEMA-3: a preset name as action is REJECTED (no preset names)", () => {
      const r = parseAdaptiveDecision(
        { ...validRaw, action: "agentless-v4-proof-clean" },
        PACKET_IDS,
      )
      expect(r.ok).toBe(false)
    })

    test("SCHEMA-4: an evidence gap outside the closed set is REJECTED", () => {
      const r = parseAdaptiveDecision({ ...validRaw, evidenceGaps: ["vibes"] }, PACKET_IDS)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toContain("unknown_evidence_gap")
    })

    test("SCHEMA-5: a cited id NOT in the packet is REJECTED (scope guard)", () => {
      const r = parseAdaptiveDecision(
        { ...validRaw, citedEvidenceIds: ["ev:smuggled"] },
        PACKET_IDS,
      )
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toContain("uncited_evidence_id")
    })

    test("SCHEMA-6: malformed shapes all FAIL CLOSED (never throw, never ok)", () => {
      for (const bad of [
        null,
        undefined,
        42,
        "accept_thin",
        {},
        { action: "accept_thin" },
        { ...validRaw, evidenceGaps: "candidate_no_positive_proof" },
        { ...validRaw, citedEvidenceIds: [1, 2] },
        { ...validRaw, why: 123 },
      ]) {
        const r = parseAdaptiveDecision(bad, PACKET_IDS)
        expect(r.ok).toBe(false)
      }
    })

    test("SCHEMA-7: empty gaps + empty citations is valid (model may be confident)", () => {
      const r = parseAdaptiveDecision(
        { action: "accept_thin", evidenceGaps: [], citedEvidenceIds: [], why: "thin looks right" },
        PACKET_IDS,
      )
      expect(r.ok).toBe(true)
    })
  })

  describe("no-drift ratchet (router set ≡ posture map keys ≡ JSON schema enum)", () => {
    test("DRIFT-1: ADAPTIVE_ACTIONS is EXACTLY the PHASE_MODULES keys", () => {
      // cast the literal-union tuple to string[] so toEqual unifies with the
      // string[] from Object.keys (same runtime value; satisfies tsc overload).
      expect(([...ADAPTIVE_ACTIONS] as string[]).sort()).toEqual(Object.keys(PHASE_MODULES).sort())
    })

    test("DRIFT-2: the JSON schema action enum matches ADAPTIVE_ACTIONS", () => {
      expect([...ADAPTIVE_DECISION_JSON_SCHEMA.properties.action.enum].sort()).toEqual(
        [...ADAPTIVE_ACTIONS].sort(),
      )
    })

    test("DRIFT-3: the JSON schema gap enum matches EVIDENCE_GAPS", () => {
      expect([...ADAPTIVE_DECISION_JSON_SCHEMA.properties.evidenceGaps.items.enum].sort()).toEqual(
        [...EVIDENCE_GAPS].sort(),
      )
    })

    test("DRIFT-4: every routable action parses (round-trip through the contract)", () => {
      for (const action of ADAPTIVE_ACTIONS) {
        const r = parseAdaptiveDecision(
          { action, evidenceGaps: [], citedEvidenceIds: [], why: "x" },
          PACKET_IDS,
        )
        expect(r.ok, `action ${action} must parse`).toBe(true)
      }
    })
  })

  describe("action classification (exhaustive partition)", () => {
    test("CLASS-1: every action is exactly one of terminal / reroute / finalize_after", () => {
      for (const action of ADAPTIVE_ACTIONS) {
        const flags = [
          isTerminalAction(action),
          isRerouteAction(action),
          classifyAction(action) === "finalize_after",
        ].filter(Boolean)
        expect(flags.length, `action ${action} must classify into exactly one class`).toBe(1)
      }
    })

    test("CLASS-2: terminal actions yield a typed stop reason", () => {
      expect(terminalStopReason("stop_infra_or_budget")).toBe("infra_or_budget")
      expect(terminalStopReason("accept_thin")).toBe("terminal_action")
      expect(terminalStopReason("run_proof_clean")).toBeUndefined()
    })
  })

  describe("bounded controller (no open-ended loop)", () => {
    test("BOUND-1: total-step cap denies with the right stop reason", () => {
      const history: AdaptiveAction[] = Array(DEFAULT_ADAPTIVE_LIMITS.maxTotalSteps).fill(
        "expand_select",
      )
      const r = admitNextStep(history, "deeper_localize")
      expect(r.admit).toBe(false)
      if (!r.admit) expect(r.stopReason).toBe("max_steps_exhausted")
    })

    test("BOUND-2: expensive-escalation cap denies further expensive actions", () => {
      const history: AdaptiveAction[] = Array(DEFAULT_ADAPTIVE_LIMITS.maxExpensive).fill(
        "run_proof_clean",
      )
      const r = admitNextStep(history, "run_public_repro")
      expect(r.admit).toBe(false)
      if (!r.admit) expect(r.stopReason).toBe("max_expensive_exhausted")
    })

    test("BOUND-3: a re-route action cannot loop past its per-action cap (red-on-injection)", () => {
      // deeper_localize is cheap, so it dodges the expensive cap — the per-action
      // cap is what stops an infinite re-route loop. Prove it terminates.
      const history: AdaptiveAction[] = Array(DEFAULT_ADAPTIVE_LIMITS.maxPerAction).fill(
        "deeper_localize",
      )
      const r = admitNextStep(history, "deeper_localize")
      expect(r.admit).toBe(false)
      if (!r.admit) expect(r.stopReason).toBe("max_per_action_exhausted")
    })

    test("BOUND-4: terminal actions are ALWAYS admitted (no budget applies)", () => {
      const full: AdaptiveAction[] = Array(99).fill("run_proof_clean")
      expect(admitNextStep(full, "accept_thin").admit).toBe(true)
      expect(admitNextStep(full, "stop_infra_or_budget").admit).toBe(true)
    })

    test("BOUND-5: a fresh history admits a first expensive step", () => {
      expect(admitNextStep([], "run_proof_clean").admit).toBe(true)
    })
  })

  // jun-25: the interpretive proof-context / ordering vetoes are DEMOTED to
  // advisory. The router's legal action set must NOT be narrowed by derived
  // proxies — only a real infra block (execution-failure receipt) stays hard.
  describe("decision legality (interpretive vetoes demoted to advisory)", () => {
    test("LEGAL-1: run_proof_clean WITHOUT proof context is NOT vetoed (advisory)", () => {
      // RED-ON-INJECTION teeth: re-add `if (lacksProofContext) return
      // "run_proof_clean_without_proof_context"` to decision-legality and this
      // flips to a defined illegal reason.
      expect(
        validateAdaptiveDecisionForEvidence(lacksProofFacts(), dec("run_proof_clean")),
      ).toBeUndefined()
    })

    test("LEGAL-2: repair_with_proof WITHOUT proof context is NOT vetoed (advisory)", () => {
      expect(
        validateAdaptiveDecisionForEvidence(lacksProofFacts(), dec("repair_with_proof")),
      ).toBeUndefined()
    })

    test("LEGAL-3: ordering vetoes are gone (run_public_repro after base repro proceeds)", () => {
      const facts: EvidenceFacts = { ...fullyEvidencedFacts(IDS), baseReproEstablished: true }
      expect(validateAdaptiveDecisionForEvidence(facts, dec("run_public_repro"))).toBeUndefined()
      // and positive-proof ordering veto is gone too
      expect(validateAdaptiveDecisionForEvidence(facts, dec("run_proof_clean"))).toBeUndefined()
    })

    test("LEGAL-4: infraBlocked STAYS a HARD veto for every expensive action", () => {
      const facts: EvidenceFacts = { ...fullyEvidencedFacts(IDS), infraBlocked: true }
      expect(validateAdaptiveDecisionForEvidence(facts, dec("run_public_repro"))).toBe(
        "run_public_repro_while_infra_blocked",
      )
      expect(validateAdaptiveDecisionForEvidence(facts, dec("run_proof_clean"))).toBe(
        "run_proof_clean_while_infra_blocked",
      )
      expect(validateAdaptiveDecisionForEvidence(facts, dec("repair_with_proof"))).toBe(
        "repair_with_proof_while_infra_blocked",
      )
    })

    test("LEGAL-5: the demoted signals are SURFACED as advisory router facts (no info lost)", () => {
      const text = renderAdvisoryRouterFacts(lacksProofFacts())
      expect(text).toContain("Router Advisory Facts")
      expect(text).toContain("lacks proof context")
      expect(text).toContain("base reproduction established: no")
      // worded as advisory, not a restriction
      expect(text.toLowerCase()).toContain("does not forbid")
    })
  })
})
