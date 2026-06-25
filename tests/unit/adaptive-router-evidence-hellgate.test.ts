/**
 * Hellgate for the v5 router evidence projection (P5). `LlmEvidencePacket` is the
 * single origin; `projectRouterEvidence` is the read-model derivation. Teeth:
 * paired-control (one packet condition ↔ one EvidenceFacts boolean), blindness
 * preserved (poisoned packet throws at projection), and the projection plugs into
 * the controller as P with evidenceIdsOf as the citation scope.
 */

import { describe, expect, test } from "bun:test"
import {
  buildRouterPrompt,
  deriveEvidenceGaps,
  evidenceIdsOf,
} from "@/runner/batch/eval/adaptive-escalation"
import {
  deriveEvidenceFactsFromPacket,
  projectRouterEvidence,
} from "@/runner/batch/eval/adaptive-escalation/router-evidence"
import type { LlmEvidencePacket } from "@/runner/batch/eval/llm-evidence-packet"

/** A blind, fully-evidenced baseline packet (no gaps when derived). */
const goodPacket = (): LlmEvidencePacket => ({
  stage: "candidate_generation",
  instanceIdHash: "deadbeefdeadbeef",
  evidenceRevision: "rev-1",
  candidatePatchHash: "cafe0000",
  question: "Which deeper phase, if any?",
  allowedActions: ["produce_minimal_patch"],
  forbiddenSources: ["hidden_tests", "gold_patch"],
  publicIssueFacts: ["the parser drops trailing commas"],
  ownerEvidence: [
    {
      file: "pkg/parse.py",
      symbols: ["parse"],
      provenance: "issue-file",
      sourceSlice: "def parse(): ...",
    },
  ],
  proofReceipts: [
    { source: "public_mwe", state: "candidate_green", baseValidatedRed: true },
    { source: "discovered_regression", state: "candidate_green" },
  ],
  contractFacts: [],
  staticFacts: [],
  verificationTarget: {
    primaryRail: { kind: "repro", cmd: "python repro.py", successPredicate: "stdout_contains" },
    required: [],
    optional: [],
    baseValidatedRed: true,
  },
  missingEvidence: [],
})

describe("router evidence projection (P5)", () => {
  test("FACTS-FROM-PACKET: a fully-evidenced packet derives ZERO gaps", () => {
    expect(deriveEvidenceGaps(deriveEvidenceFactsFromPacket(goodPacket()))).toEqual([])
  })

  describe("paired-control: one packet condition toggles one fact/gap", () => {
    const cases: ReadonlyArray<{
      name: string
      mutate: (p: LlmEvidencePacket) => LlmEvidencePacket
      gap: string
    }> = [
      {
        name: "no owner source slice → localization_uncertain",
        mutate: (p) => ({ ...p, ownerEvidence: [{ file: "a.py", symbols: [], provenance: "x" }] }),
        gap: "localization_uncertain",
      },
      {
        name: "verification target without primary rail → issue_condition_not_evidenced",
        mutate: (p) => ({
          ...p,
          verificationTarget: {
            primaryRail: null,
            required: [],
            optional: [],
            baseValidatedRed: true,
          },
        }),
        gap: "issue_condition_not_evidenced",
      },
      {
        name: "no candidate_green receipt → candidate_no_positive_proof",
        mutate: (p) => ({
          ...p,
          proofReceipts: [{ source: "public_mwe", state: "candidate_red", baseValidatedRed: true }],
        }),
        gap: "candidate_no_positive_proof",
      },
      {
        name: "multiple owners → multi_owner_likely",
        mutate: (p) => ({
          ...p,
          ownerEvidence: [
            { file: "a.py", symbols: [], provenance: "x", sourceSlice: "s" },
            { file: "b.py", symbols: [], provenance: "y", sourceSlice: "t" },
          ],
        }),
        gap: "multi_owner_likely",
      },
      {
        name: "no base-red receipt/target → base_repro_missing",
        mutate: (p) => ({
          ...p,
          proofReceipts: [{ source: "public_mwe", state: "candidate_green" }],
          verificationTarget: {
            primaryRail: p.verificationTarget!.primaryRail,
            required: [],
            optional: [],
            baseValidatedRed: false,
          },
        }),
        gap: "base_repro_missing",
      },
      {
        name: "no discovered_regression receipt → regression_signal_missing",
        mutate: (p) => ({
          ...p,
          proofReceipts: [
            { source: "public_mwe", state: "candidate_green", baseValidatedRed: true },
          ],
        }),
        gap: "regression_signal_missing",
      },
      {
        name: "execution_failed receipt → infra_blocked",
        mutate: (p) => ({
          ...p,
          proofReceipts: [...p.proofReceipts, { source: "public_mwe", state: "execution_failed" }],
        }),
        gap: "infra_blocked",
      },
    ]
    for (const { name, mutate, gap } of cases) {
      test(name, () => {
        const gaps: readonly string[] = deriveEvidenceGaps(
          deriveEvidenceFactsFromPacket(mutate(goodPacket())),
        )
        expect(gaps).toContain(gap)
        // paired-control: the baseline had NONE of these gaps, so the mutation
        // is what introduced exactly this one (cross-check it's not always-on).
        expect(deriveEvidenceGaps(deriveEvidenceFactsFromPacket(goodPacket()))).not.toContain(gap)
      })
    }

    test("PROXY-DEMOTED: a `public_proof` missingEvidence entry does NOT set infraBlocked", () => {
      // jun-25 fix: the HARD infra veto must be backed by a real execution-failure
      // receipt only. The `public_proof` missingEvidence entry is a DERIVED proxy
      // (selection's infra_blocked summary label), so it must NOT flip infraBlocked
      // / the infra_blocked gap — it reaches the model only as an advisory.
      const facts = deriveEvidenceFactsFromPacket({
        ...goodPacket(),
        missingEvidence: [{ kind: "public_proof", reason: "public_proof_infra_blocked" }],
      })
      expect(facts.infraBlocked).toBe(false)
      expect(deriveEvidenceGaps(facts)).not.toContain("infra_blocked")
    })
  })

  test("BLIND: projecting a packet renders blindness-audited bytes (clean packet ok)", () => {
    const re = projectRouterEvidence(goodPacket())
    expect(re.rendered.length).toBeGreaterThan(0)
    expect(re.rendered).not.toContain("FAIL_TO_PASS")
    expect(re.rendered).not.toContain("PASS_TO_PASS")
    expect(re.origin.evidenceRevision).toBe("rev-1")
  })

  test("RED-on-injection: projecting a poisoned packet THROWS at the render step", () => {
    const poisoned: LlmEvidencePacket = {
      ...goodPacket(),
      publicIssueFacts: ["leaked FAIL_TO_PASS marker"],
    }
    expect(() => projectRouterEvidence(poisoned)).toThrow()
  })

  test("INTEGRATE: projection is a controller P — citableIds + prompt attach", () => {
    const re = projectRouterEvidence(goodPacket())
    const ids = evidenceIdsOf(re.facts)
    expect([...ids].sort()).toEqual(["candidate", "issue", "owners", "proof"])
    expect(buildRouterPrompt(re.rendered)).toContain(re.rendered)
  })
})
