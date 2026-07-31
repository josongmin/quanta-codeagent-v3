/**
 * Wiring-proof: buildReport MUST carry the eval-only telemetry fields
 * (gradeBreakdown, reproOracleCalibration, selectionTelemetry) from
 * InstanceResult into the JSON
 * report's perInstance. A prior sweep silently DROPPED the reproOracleCalibration
 * mapping (the field was declared but never populated) — so a verify-select run
 * computed the false-negative calibration but report.json showed `null`. The
 * parser unit tests pass while the end-to-end report is empty: slice-green ≠
 * tree-green. These teeth assert the map survives, red-on-injection if dropped.
 */
import { describe, expect, test } from "bun:test"
import {
  buildIntakeLlmEvidencePacket,
  buildSelectionExplanationPacket,
} from "@/runner/batch/eval/llm-evidence-packet"
import type { PerInstanceReport } from "@/runner/batch/report"
import { buildReport } from "@/runner/batch/report"
import type {
  GradeBreakdown,
  InstanceResult,
  LlmEvidenceArtifacts,
  OwnerWideningTelemetry,
  RepairValidationDecision,
  ReproOracleCalibration,
  SelectionTelemetry,
} from "@/runner/batch/types"

const baseResult = (over: Partial<InstanceResult>): InstanceResult => ({
  id: "sympy__sympy-1",
  passed: false,
  patch: "diff --git a/x b/x\n",
  turns: 10,
  ...over,
})

const meta = { model: "gpt-5.5", provider: "chatgpt-oauth", n: 1 }

describe("buildReport carries eval-only telemetry into perInstance", () => {
  test("gradeBreakdown survives", () => {
    const gb: GradeBreakdown = {
      resolved: false,
      failToPassFailed: 1,
      passToPassFailed: 0,
      passToPassTotal: 40,
    }
    const rep = buildReport(meta, [baseResult({ gradeBreakdown: gb })])
    expect(rep.perInstance[0]?.gradeBreakdown).toEqual(gb)
  })

  // The exact field a sweep dropped — red-on-injection if the mapping is removed.
  test("reproOracleCalibration survives (the dropped one)", () => {
    const cal: ReproOracleCalibration = {
      goldCalibrated: false,
      falseNegative: true,
      available: true,
      goldVotes: 0,
      goldK: 2,
    }
    const rep = buildReport(meta, [baseResult({ reproOracleCalibration: cal })])
    expect(rep.perInstance[0]?.reproOracleCalibration).toEqual(cal)
  })

  // jun-28: reproVoteOutcomes was attached to InstanceResult but DROPPED at report
  // serialization — an A/B campaign read `null`. Red-on-injection if re-dropped.
  test("reproVoteOutcomes survives into perInstance", () => {
    const votes = {
      rounds: [
        {
          outcome: "vote_resolved" as const,
          detail: { resolved: 2, reproduced: 0, inconclusive: 1 },
        },
      ],
      tally: {
        empty_sources: 0,
        exec_failed: 0,
        vote_resolved: 1,
        vote_unresolved: 0,
        vote_inconclusive: 0,
      },
    }
    const rep = buildReport(meta, [baseResult({ reproVoteOutcomes: votes })])
    expect(rep.perInstance[0]?.reproVoteOutcomes).toEqual(votes)
  })

  test("repairValidationDecision survives into perInstance", () => {
    const decision: RepairValidationDecision = {
      authority: "canonical-sidecar",
      issueResolved: true,
      regressionFailed: null,
      adoptable: true,
      reason: "canonical sidecar resolved",
    }
    const rep = buildReport(meta, [baseResult({ repairValidationDecision: decision })])
    expect(rep.perInstance[0]?.repairValidationDecision).toEqual(decision)
  })

  test("reproArtifactPath survives into perInstance", () => {
    const path = "/tmp/observe/run-123/repro/sympy__sympy-1"
    const rep = buildReport(meta, [baseResult({ reproArtifactPath: path })])
    expect(rep.perInstance[0]?.reproArtifactPath).toBe(path)
  })

  test("selectionTelemetry survives (verify-select diagnosis stays in report)", () => {
    const t: SelectionTelemetry = {
      attempted: 2,
      successfulGenerations: 2,
      generationFailures: 0,
      generationFailureSamples: ["capture_lost_edits: ... sandbox=/tmp/fork-1"],
      ownerFiles: ["root.py"],
      earlyAccepted: false,
      generated: 2,
      admissibleCount: 1,
      winnerId: "cand-1",
      proofRequired: true,
      proofSummary: {
        proofState: "proof_positive",
        proofSource: "repro_consensus",
        proofRequiredMissing: false,
        contractOnlySubmitted: false,
        contractOnlyBlocked: false,
        publicRegressionState: "safety_green",
        reproConsensusState: "base_red_candidate_green",
        repairOnlyCandidates: 1,
        submittedCandidateProof: true,
      },
      candidates: [
        {
          id: "cand-0",
          files: ["symptom.py"],
          sandboxPath: "/tmp/fork-0",
          captureClass: "source-captured",
          admissible: false,
          score: 0.2,
          reasons: ["hard:regressionGreen=false"],
          proofState: "candidate_red",
        },
        {
          id: "cand-1",
          files: ["root.py"],
          sandboxPath: "/tmp/fork-1",
          captureClass: "source-captured",
          admissible: true,
          score: 0.9,
          reasons: ["soft:ownerCoverage=1"],
          proofState: "proof_positive",
        },
      ],
    }
    const rep = buildReport(meta, [baseResult({ selectionTelemetry: t })])
    expect(rep.perInstance[0]?.selectionTelemetry).toEqual(t)
    expect(rep.perInstance[0]?.selectionTelemetry?.generationFailureSamples).toEqual([
      "capture_lost_edits: ... sandbox=/tmp/fork-1",
    ])
    expect(rep.perInstance[0]?.selectionTelemetry?.candidates[0]?.sandboxPath).toBe("/tmp/fork-0")
    expect(rep.perInstance[0]?.selectionTelemetry?.candidates[1]?.captureClass).toBe(
      "source-captured",
    )
    expect(rep.perInstance[0]?.proofState).toBe("proof_positive")
    expect(rep.perInstance[0]?.proofSource).toBe("repro_consensus")
    expect(rep.perInstance[0]?.publicRegressionState).toBe("safety_green")
    expect(rep.perInstance[0]?.reproConsensusState).toBe("base_red_candidate_green")
    expect(rep.proofTotals).toEqual({
      submittedWithProof: 1,
      blockedProofMissing: 0,
      blockedEnvFailed: 0,
      contractOnlyBlocked: 0,
      contractOnlySubmitted: 0,
    })
  })

  test("scoreLabel + scoreEvidence survive and feed scoreTotals", () => {
    const rep = buildReport(meta, [
      baseResult({
        passed: true,
        scoreLabel: "research_contaminated",
        scoreEvidence: {
          officialHarnessResolved: true,
          localExecutedGreen: true,
          researchKnobTouched: true,
        },
      }),
      baseResult({
        id: "sympy__sympy-2",
        passed: true,
        scoreLabel: "official_harness",
        scoreEvidence: {
          officialHarnessResolved: true,
          localExecutedGreen: true,
          researchKnobTouched: false,
        },
      }),
    ])
    expect(rep.perInstance[0]?.scoreLabel).toBe("research_contaminated")
    expect(rep.perInstance[0]?.scoreEvidence).toEqual({
      officialHarnessResolved: true,
      localExecutedGreen: true,
      researchKnobTouched: true,
    })
    expect(rep.scoreTotals).toEqual({
      officialHarness: 1,
      localStructural: 0,
      researchContaminated: 1,
      unlabeledPassed: 0,
      officialResolvedPct: 50,
    })
  })

  test("ownerWidening survives so bounded follow-up localization is audit-visible", () => {
    const rep = buildReport(meta, [
      baseResult({
        ownerWidening: {
          owners: ["pkg/base.py", "pkg/consumer.py"],
          sources: ["repair_escalation", "forward_localize"],
          path: "adaptive_reroute",
        },
      }),
    ])
    // `buildReport` (report.ts) folds `ownerWidening` into the per-instance row,
    // but `PerInstanceReport` does not surface the field on its public type. Read
    // through the actual emitted shape so this wiring-proof stays type-precise.
    const row = rep.perInstance[0] as
      | (PerInstanceReport & { ownerWidening?: OwnerWideningTelemetry })
      | undefined
    expect(row?.ownerWidening).toEqual({
      owners: ["pkg/base.py", "pkg/consumer.py"],
      sources: ["repair_escalation", "forward_localize"],
      path: "adaptive_reroute",
    })
  })

  test("llmEvidence survives for report-only RCA packets", () => {
    // Build with the real typed builders so the round-trip exercises the actual
    // packet shape (not a hand-faked literal that can drift from the schema).
    const problem = "repro exists in run() for the public issue"
    const llmEvidence = {
      intake: buildIntakeLlmEvidencePacket({
        problemStatement: problem,
        localizeCandidates: ["pkg/core.py"],
      }),
      candidateGeneration: {
        stage: "candidate_generation",
        instanceIdHash: "abc123",
        evidenceRevision: "selection-generation-v2",
        question: "Produce one minimal candidate patch.",
        allowedActions: [],
        forbiddenSources: [],
        publicIssueFacts: ["issue summary: repro exists"],
        ownerEvidence: [],
        proofReceipts: [],
        contractFacts: [],
        staticFacts: [],
        missingEvidence: [{ kind: "verification_target", reason: "missing" }],
      },
      repairSeed: {
        stage: "repair_seed",
        instanceIdHash: "abc123",
        evidenceRevision: "selector-repair-v2",
        candidatePatchHash: "deadbeef",
        question: "Generate a bounded repair instruction.",
        allowedActions: [],
        forbiddenSources: [],
        publicIssueFacts: ["issue summary: repro exists"],
        ownerEvidence: [],
        proofReceipts: [{ source: "public_mwe", state: "execution_failed" }],
        contractFacts: [],
        staticFacts: [],
        missingEvidence: [{ kind: "executed_public_proof", reason: "not green yet" }],
      },
      selectionExplanation: buildSelectionExplanationPacket({
        problemStatement: problem,
        ownerFiles: ["pkg/core.py"],
        winnerId: null,
        candidates: [],
      }),
    } as LlmEvidenceArtifacts
    const rep = buildReport(meta, [baseResult({ llmEvidence })])
    expect(rep.perInstance[0]?.llmEvidence).toEqual(llmEvidence)
    // Teeth: the serialized packets are the typed shape, not free strings.
    expect(rep.perInstance[0]?.llmEvidence?.intake?.stage).toBe("intake")
    expect(rep.perInstance[0]?.llmEvidence?.selectionExplanation?.ownerEvidence[0]?.file).toBe(
      "pkg/core.py",
    )
    expect(rep.perInstance[0]?.llmEvidenceStages).toEqual([
      "intake",
      "candidate_generation",
      "repair_seed",
      "selection_explanation",
    ])
    expect(rep.perInstance[0]?.llmEvidenceRevision).toEqual({
      intake: "intake-v2",
      candidate_generation: "selection-generation-v2",
      repair_seed: "selector-repair-v2",
      selection_explanation: "selection-explanation-v2",
    })
    expect(rep.perInstance[0]?.llmEvidenceMissingKinds).toEqual([
      "fault_evidence",
      "verification_plan",
      "public_mwe_seed",
      "public_mwe_base",
      "verification_target",
      "executed_public_proof",
      "winner",
    ])
    expect(rep.llmEvidenceTotals).toEqual({
      packetizedGenerationCount: 1,
      packetizedRepairCount: 1,
      packetizedSelectionExplanationCount: 1,
    })
  })

  test("multiple packets from one stage preserve exact stage counts and unioned missing kinds", () => {
    const mkPacket = (
      stage: "candidate_generation" | "repair_seed",
      revision: string,
      missingKind: string,
    ) => ({
      stage,
      instanceIdHash: "abc123",
      evidenceRevision: revision,
      question: "q",
      allowedActions: [],
      forbiddenSources: [],
      publicIssueFacts: [],
      ownerEvidence: [],
      proofReceipts: [],
      contractFacts: [],
      staticFacts: [],
      missingEvidence: [{ kind: missingKind, reason: missingKind }],
    })
    const rep = buildReport(meta, [
      baseResult({
        llmEvidence: {
          candidateGeneration: mkPacket("candidate_generation", "gen-v1", "first_generation"),
          candidateGenerationHistory: [
            mkPacket("candidate_generation", "gen-v1", "first_generation"),
            mkPacket("candidate_generation", "gen-v1", "second_generation"),
          ],
          repairSeed: mkPacket("repair_seed", "repair-v1", "first_repair"),
          repairSeedHistory: [
            mkPacket("repair_seed", "repair-v1", "first_repair"),
            mkPacket("repair_seed", "repair-v1", "second_repair"),
          ],
        } as LlmEvidenceArtifacts,
      }),
    ])
    expect(rep.llmEvidenceTotals).toEqual({
      packetizedGenerationCount: 2,
      packetizedRepairCount: 2,
      packetizedSelectionExplanationCount: 0,
    })
    expect(rep.perInstance[0]?.llmEvidenceMissingKinds).toEqual([
      "first_generation",
      "second_generation",
      "first_repair",
      "second_repair",
    ])
  })

  test("candidate_review stage survives per-instance llmEvidence summary even though it is not counted in submission totals", () => {
    const reviewPacket = {
      stage: "candidate_review" as const,
      instanceIdHash: "abc123",
      evidenceRevision: "risk-gate-v2",
      question: "q",
      allowedActions: [],
      forbiddenSources: [],
      publicIssueFacts: [],
      ownerEvidence: [],
      proofReceipts: [],
      contractFacts: [],
      staticFacts: [],
      missingEvidence: [{ kind: "risk_context", reason: "risk_context" }],
    }
    const rep = buildReport(meta, [
      baseResult({
        llmEvidence: {
          candidateReview: reviewPacket,
        } as LlmEvidenceArtifacts & { candidateReview: typeof reviewPacket },
      }),
    ])
    expect(rep.perInstance[0]?.llmEvidenceStages).toEqual(["candidate_review"])
    expect(rep.perInstance[0]?.llmEvidenceRevision).toEqual({ candidate_review: "risk-gate-v2" })
    expect(rep.perInstance[0]?.llmEvidenceMissingKinds).toEqual(["risk_context"])
    expect(rep.llmEvidenceTotals).toEqual({
      packetizedGenerationCount: 0,
      packetizedRepairCount: 0,
      packetizedSelectionExplanationCount: 0,
    })
  })

  test("candidate_post_review stage survives per-instance llmEvidence summary even though it is not counted in submission totals", () => {
    const reviewPacket = {
      stage: "candidate_post_review" as const,
      instanceIdHash: "abc123",
      evidenceRevision: "candidate-post-review-v1",
      question: "q",
      allowedActions: [],
      forbiddenSources: [],
      publicIssueFacts: [],
      ownerEvidence: [],
      proofReceipts: [{ source: "public_mwe", state: "candidate_red" as const }],
      contractFacts: [],
      staticFacts: [],
      missingEvidence: [],
    }
    const rep = buildReport(meta, [
      baseResult({
        llmEvidence: {
          candidatePostReview: reviewPacket,
        } as LlmEvidenceArtifacts & { candidatePostReview: typeof reviewPacket },
      }),
    ])
    expect(rep.perInstance[0]?.llmEvidenceStages).toEqual(["candidate_post_review"])
    expect(rep.perInstance[0]?.llmEvidenceRevision).toEqual({
      candidate_post_review: "candidate-post-review-v1",
    })
    expect(rep.llmEvidenceTotals).toEqual({
      packetizedGenerationCount: 0,
      packetizedRepairCount: 0,
      packetizedSelectionExplanationCount: 0,
    })
  })

  // Byte-identical contract: absent telemetry ⇒ keys omitted (not null).
  test("absent telemetry ⇒ keys omitted (byte-identical)", () => {
    const rep = buildReport(meta, [baseResult({})])
    expect("gradeBreakdown" in (rep.perInstance[0] ?? {})).toBe(false)
    expect("reproOracleCalibration" in (rep.perInstance[0] ?? {})).toBe(false)
    expect("selectionTelemetry" in (rep.perInstance[0] ?? {})).toBe(false)
    expect("proofState" in (rep.perInstance[0] ?? {})).toBe(false)
    expect("scoreLabel" in (rep.perInstance[0] ?? {})).toBe(false)
    expect("scoreEvidence" in (rep.perInstance[0] ?? {})).toBe(false)
    expect("llmEvidence" in (rep.perInstance[0] ?? {})).toBe(false)
    expect("llmEvidenceStages" in (rep.perInstance[0] ?? {})).toBe(false)
    expect("llmEvidenceRevision" in (rep.perInstance[0] ?? {})).toBe(false)
    expect("llmEvidenceMissingKinds" in (rep.perInstance[0] ?? {})).toBe(false)
  })
})
