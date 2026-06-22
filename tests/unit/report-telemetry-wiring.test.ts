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
import { buildReport } from "@/runner/batch/report"
import type {
  GradeBreakdown,
  InstanceResult,
  LlmEvidenceArtifacts,
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

  test("selectionTelemetry survives (verify-select diagnosis stays in report)", () => {
    const t: SelectionTelemetry = {
      attempted: 2,
      successfulGenerations: 2,
      generationFailures: 0,
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
          admissible: false,
          score: 0.2,
          reasons: ["hard:regressionGreen=false"],
          proofState: "candidate_red",
        },
        {
          id: "cand-1",
          files: ["root.py"],
          admissible: true,
          score: 0.9,
          reasons: ["soft:ownerCoverage=1"],
          proofState: "proof_positive",
        },
      ],
    }
    const rep = buildReport(meta, [baseResult({ selectionTelemetry: t })])
    expect(rep.perInstance[0]?.selectionTelemetry).toEqual(t)
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

  test("llmEvidence survives for report-only RCA packets", () => {
    // Build with the real typed builders so the round-trip exercises the actual
    // packet shape (not a hand-faked literal that can drift from the schema).
    const problem = "repro exists in run() for the public issue"
    const llmEvidence: LlmEvidenceArtifacts = {
      intake: buildIntakeLlmEvidencePacket({
        problemStatement: problem,
        localizeCandidates: ["pkg/core.py"],
      }),
      selectionExplanation: buildSelectionExplanationPacket({
        problemStatement: problem,
        ownerFiles: ["pkg/core.py"],
        winnerId: null,
        candidates: [],
      }),
    }
    const rep = buildReport(meta, [baseResult({ llmEvidence })])
    expect(rep.perInstance[0]?.llmEvidence).toEqual(llmEvidence)
    // Teeth: the serialized packets are the typed shape, not free strings.
    expect(rep.perInstance[0]?.llmEvidence?.intake?.stage).toBe("intake")
    expect(rep.perInstance[0]?.llmEvidence?.selectionExplanation?.ownerEvidence[0]?.file).toBe(
      "pkg/core.py",
    )
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
  })
})
