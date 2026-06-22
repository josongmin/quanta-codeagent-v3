import { describe, expect, it } from "bun:test"
import { deriveEvidenceGaps } from "@/runner/batch/eval/adaptive-escalation/evidence-facts"
import { buildEvidenceFactsFromPacket } from "@/runner/batch/eval/adaptive-escalation/evidence-builder"
import type { LlmEvidencePacket } from "@/runner/batch/eval/llm-evidence-packet"

// D1/#3: EvidenceFacts is a PURE DERIVED projection of the LlmEvidencePacket SSOT.
// Teeth: a fully-evidenced packet yields NO gaps; flipping exactly one packet
// signal toggles exactly one router gap (paired control); a thin packet routes
// toward escalation (conservative all-gaps).

const fullyEvidencedPacket = (over: Partial<LlmEvidencePacket> = {}): LlmEvidencePacket => ({
  stage: "candidate_review",
  instanceIdHash: "ihash",
  evidenceRevision: "r1",
  candidatePatchHash: "chash",
  question: "route?",
  allowedActions: [],
  forbiddenSources: [],
  publicIssueFacts: [],
  ownerEvidence: [{ file: "pkg/a.py", symbols: ["f"], provenance: "issue-file", sourceSlice: "def f(): ..." }],
  proofReceipts: [
    { source: "public_mwe", state: "candidate_green", baseValidatedRed: true },
    { source: "discovered_regression", state: "base_green" },
  ],
  contractFacts: [],
  staticFacts: [],
  verificationTarget: { primaryRail: { kind: "repro" }, required: [], optional: [], baseValidatedRed: true },
  missingEvidence: [],
  ...over,
})

const gapsOf = (over: Partial<LlmEvidencePacket> = {}): readonly string[] =>
  deriveEvidenceGaps(buildEvidenceFactsFromPacket(fullyEvidencedPacket(over)))

describe("buildEvidenceFactsFromPacket — derived projection (D1/#3)", () => {
  it("a fully-evidenced packet derives ZERO gaps", () => {
    expect(gapsOf()).toEqual([])
  })

  it("stable ids come from the packet hashes (citable scope)", () => {
    const f = buildEvidenceFactsFromPacket(fullyEvidencedPacket())
    expect(f.issueId).toBe("ev:issue:ihash")
    expect(f.candidateId).toBe("ev:cand:chash")
    expect(f.proofId).toBe("ev:proof:ihash")
  })

  // ── paired controls: one packet signal → exactly one gap ──────────────────
  it("missing owner_slice ⇒ ONLY localization_uncertain", () => {
    expect(gapsOf({ missingEvidence: [{ kind: "owner_slice", reason: "no_resolvable_slice:pkg/a.py" }] })).toEqual([
      "localization_uncertain",
    ])
  })

  it("no candidate_green receipt ⇒ ONLY candidate_no_positive_proof", () => {
    expect(
      gapsOf({
        proofReceipts: [
          { source: "public_mwe", state: "candidate_red", baseValidatedRed: true },
          { source: "discovered_regression", state: "base_green" },
        ],
      }),
    ).toEqual(["candidate_no_positive_proof"])
  })

  it("missing public_repro ⇒ ONLY base_repro_missing", () => {
    expect(gapsOf({ missingEvidence: [{ kind: "public_repro", reason: "no_executable_public_repro_hint" }] })).toEqual([
      "base_repro_missing",
    ])
  })

  it("no discovered_regression receipt ⇒ ONLY regression_signal_missing", () => {
    expect(gapsOf({ proofReceipts: [{ source: "public_mwe", state: "candidate_green", baseValidatedRed: true }] })).toEqual(
      ["regression_signal_missing"],
    )
  })

  it("a second owner file ⇒ ONLY multi_owner_likely", () => {
    expect(
      gapsOf({
        ownerEvidence: [
          { file: "pkg/a.py", symbols: ["f"], provenance: "issue-file", sourceSlice: "def f(): ..." },
          { file: "pkg/b.py", symbols: ["g"], provenance: "static-witness", sourceSlice: "def g(): ..." },
        ],
      }),
    ).toEqual(["multi_owner_likely"])
  })

  it("an execution_failed receipt ⇒ ONLY infra_blocked", () => {
    expect(
      gapsOf({
        proofReceipts: [
          { source: "public_mwe", state: "candidate_green", baseValidatedRed: true },
          { source: "discovered_regression", state: "base_green" },
          { source: "repro_consensus", state: "execution_failed" },
        ],
      }),
    ).toEqual(["infra_blocked"])
  })

  it("missing verification_target ⇒ ONLY issue_condition_not_evidenced (condition WAS declared)", () => {
    expect(
      gapsOf({ missingEvidence: [{ kind: "verification_target", reason: "no_verification_plan_available" }] }),
    ).toEqual(["issue_condition_not_evidenced"])
  })

  it("no primary rail ⇒ declaredConditionEvidenced is null (NO condition gap)", () => {
    const f = buildEvidenceFactsFromPacket(
      fullyEvidencedPacket({ verificationTarget: { primaryRail: null, required: [], optional: [], baseValidatedRed: true } }),
    )
    expect(f.declaredConditionEvidenced).toBeNull()
    expect(deriveEvidenceGaps(f)).not.toContain("issue_condition_not_evidenced")
  })

  // ── conservative default: a thin/empty packet routes toward escalation ────
  it("a thin (no-evidence) packet derives ALL evidence gaps (escalation direction)", () => {
    const thin: LlmEvidencePacket = {
      stage: "intake",
      instanceIdHash: "ihash",
      evidenceRevision: "r1",
      question: "route?",
      allowedActions: [],
      forbiddenSources: [],
      publicIssueFacts: [],
      ownerEvidence: [],
      proofReceipts: [],
      contractFacts: [],
      staticFacts: [],
      missingEvidence: [],
    }
    const gaps: readonly string[] = deriveEvidenceGaps(buildEvidenceFactsFromPacket(thin))
    // every gap that can fire from absence-of-signal must be present …
    for (const g of [
      "localization_uncertain",
      "candidate_no_positive_proof",
      "base_repro_missing",
      "regression_signal_missing",
    ]) {
      expect(gaps).toContain(g)
    }
    // … but multi_owner / infra (presence signals) and the condition gap (no
    // condition declared ⇒ null) must NOT fire on an empty packet.
    expect(gaps).not.toContain("multi_owner_likely")
    expect(gaps).not.toContain("infra_blocked")
    expect(gaps).not.toContain("issue_condition_not_evidenced")
  })
})
