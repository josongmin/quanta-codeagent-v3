/**
 * B9 hellgate — router facts must be CANDIDATE-LOCAL after B1+B7.
 *
 * `localizationCertain` / `positiveProof` must correlate to the CURRENT candidate
 * (identified by `packet.candidatePatchHash`) — aligning receipts and edit surface
 * by patch hash — instead of the coarse "any owner sourceSlice / any candidate_green".
 *
 * Teeth: PAIRED-CONTROL. Flipping ONE candidate's slice/proof flips ONLY that
 * candidate's router fact; a green/slice that belongs to a DIFFERENT candidate must
 * NOT light up the current candidate's fact.
 *
 * Red-without-fix: before B9, `positiveProof = receipts.some(candidate_green)`
 * (hash-blind) so a foreign-candidate green flips it true; `localizationCertain =
 * any owner sourceSlice` so a slice for an UNTOUCHED owner flips it true.
 */

import { describe, expect, test } from "bun:test"
import { deriveEvidenceFactsFromPacket } from "@/runner/batch/eval/adaptive-escalation/router-evidence"
import type {
  CandidateEditSurfaceFact,
  LlmEvidencePacket,
  OwnerEvidenceFact,
  ProofReceiptFact,
} from "@/runner/batch/eval/llm-evidence-packet"

const THIS_HASH = "candA000"
const OTHER_HASH = "candB111"

const basePacket = (over: {
  ownerEvidence: readonly OwnerEvidenceFact[]
  proofReceipts: readonly ProofReceiptFact[]
  candidateEditSurface?: CandidateEditSurfaceFact
}): LlmEvidencePacket => ({
  stage: "candidate_post_review",
  instanceIdHash: "deadbeefdeadbeef",
  evidenceRevision: "rev-1",
  candidatePatchHash: THIS_HASH,
  question: "Diagnose.",
  allowedActions: ["diagnose_executed_candidate"],
  forbiddenSources: ["hidden_tests"],
  publicIssueFacts: ["the parser drops trailing commas"],
  ownerEvidence: over.ownerEvidence,
  proofReceipts: over.proofReceipts,
  contractFacts: [],
  staticFacts: [],
  missingEvidence: [],
  ...(over.candidateEditSurface !== undefined
    ? { candidateEditSurface: over.candidateEditSurface }
    : {}),
})

describe("B9 — candidate-local router facts (paired-control by patch hash)", () => {
  test("positiveProof: a candidate_green tagged to a DIFFERENT candidate does NOT count", () => {
    const facts = deriveEvidenceFactsFromPacket(
      basePacket({
        ownerEvidence: [
          {
            file: "pkg/parse.py",
            symbols: ["parse"],
            provenance: "issue-file",
            sourceSlice: "def parse(): ...",
          },
        ],
        proofReceipts: [
          { source: "public_mwe", state: "candidate_green", candidatePatchHash: OTHER_HASH },
        ],
        candidateEditSurface: { touchedFiles: ["pkg/parse.py"], touchedSymbols: ["parse"] },
      }),
    )
    expect(facts.positiveProof).toBe(false)
  })

  test("positiveProof: a candidate_green tagged to THIS candidate DOES count", () => {
    const facts = deriveEvidenceFactsFromPacket(
      basePacket({
        ownerEvidence: [
          {
            file: "pkg/parse.py",
            symbols: ["parse"],
            provenance: "issue-file",
            sourceSlice: "def parse(): ...",
          },
        ],
        proofReceipts: [
          { source: "public_mwe", state: "candidate_green", candidatePatchHash: THIS_HASH },
        ],
        candidateEditSurface: { touchedFiles: ["pkg/parse.py"], touchedSymbols: ["parse"] },
      }),
    )
    expect(facts.positiveProof).toBe(true)
  })

  test("localizationCertain: a slice for an owner the candidate did NOT touch does NOT count", () => {
    const facts = deriveEvidenceFactsFromPacket(
      basePacket({
        // Slice resolved for owner_a.py, but the candidate touched owner_b.py only.
        ownerEvidence: [
          {
            file: "owner_a.py",
            symbols: ["a"],
            provenance: "issue-file",
            sourceSlice: "def a(): ...",
          },
        ],
        proofReceipts: [],
        candidateEditSurface: { touchedFiles: ["owner_b.py"], touchedSymbols: ["b"] },
      }),
    )
    expect(facts.localizationCertain).toBe(false)
  })

  test("localizationCertain: a slice for an owner the candidate DID touch counts", () => {
    const facts = deriveEvidenceFactsFromPacket(
      basePacket({
        ownerEvidence: [
          {
            file: "owner_a.py",
            symbols: ["a"],
            provenance: "issue-file",
            sourceSlice: "def a(): ...",
          },
        ],
        proofReceipts: [],
        candidateEditSurface: { touchedFiles: ["owner_a.py"], touchedSymbols: ["a"] },
      }),
    )
    expect(facts.localizationCertain).toBe(true)
  })

  test("PAIRED-CONTROL: flipping the touched-file alignment flips ONLY localizationCertain", () => {
    const aligned = deriveEvidenceFactsFromPacket(
      basePacket({
        ownerEvidence: [
          { file: "x.py", symbols: ["x"], provenance: "issue-file", sourceSlice: "def x(): ..." },
        ],
        proofReceipts: [
          { source: "public_mwe", state: "candidate_green", candidatePatchHash: THIS_HASH },
        ],
        candidateEditSurface: { touchedFiles: ["x.py"], touchedSymbols: ["x"] },
      }),
    )
    const misaligned = deriveEvidenceFactsFromPacket(
      basePacket({
        ownerEvidence: [
          { file: "x.py", symbols: ["x"], provenance: "issue-file", sourceSlice: "def x(): ..." },
        ],
        proofReceipts: [
          { source: "public_mwe", state: "candidate_green", candidatePatchHash: THIS_HASH },
        ],
        candidateEditSurface: { touchedFiles: ["other.py"], touchedSymbols: ["other"] },
      }),
    )
    expect(aligned.localizationCertain).toBe(true)
    expect(misaligned.localizationCertain).toBe(false)
    // positiveProof is unchanged by the edit-surface flip (only localization moved).
    expect(aligned.positiveProof).toBe(true)
    expect(misaligned.positiveProof).toBe(true)
  })

  test("BACKWARD-COMPAT: with no edit surface and untagged receipts, facts stay coarse (generation path)", () => {
    const facts = deriveEvidenceFactsFromPacket(
      basePacket({
        ownerEvidence: [
          { file: "x.py", symbols: ["x"], provenance: "issue-file", sourceSlice: "def x(): ..." },
        ],
        proofReceipts: [{ source: "public_mwe", state: "candidate_green" }],
      }),
    )
    expect(facts.localizationCertain).toBe(true)
    expect(facts.positiveProof).toBe(true)
  })
})
