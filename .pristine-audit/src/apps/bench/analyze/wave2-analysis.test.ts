import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildWave2AbRail,
  buildWave2BacklogArtifact,
  buildWave2CoverageCensus,
} from "./wave2-analysis"

let dir: string

const patchForFiles = (...files: string[]): string =>
  files
    .map(
      (file, index) =>
        `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old_${index}\n+new_${index}\n`,
    )
    .join("\n")

const predictionRow = (instanceId: string, ...files: string[]) => ({
  instance_id: instanceId,
  model_name_or_path: "gpt-5.4",
  model_patch: patchForFiles(...files),
})

const unresolvedRow = (id: string, patch: string) => ({
  id,
  passed: false,
  turns: 1,
  patchBytes: Buffer.byteLength(patch, "utf8"),
  gradeBreakdown: {
    resolved: false,
    failToPassFailed: 1,
    passToPassFailed: 0,
    passToPassTotal: 1,
  },
})

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "wave2-analysis-"))

  writeFileSync(
    join(dir, "dataset.jsonl"),
    [
      {
        instance_id: "multi__same",
        patch: patchForFiles("pkg/a.py", "pkg/b.py"),
      },
      {
        instance_id: "multi__partial",
        patch: patchForFiles("pkg/a.py", "pkg/b.py", "pkg/c.py"),
      },
      {
        instance_id: "multi__disjoint",
        patch: patchForFiles("pkg/a.py", "pkg/b.py"),
      },
      {
        instance_id: "oracle__bad",
        patch: patchForFiles("pkg/a.py", "pkg/b.py"),
      },
      {
        instance_id: "single__wrong",
        patch: patchForFiles("pkg/only.py"),
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n"),
  )

  writeFileSync(
    join(dir, "coverage-report.json"),
    JSON.stringify({
      timestamp: "2026-06-24T00:00:00+09:00",
      model: "gpt-5.4",
      provider: "openai",
      n: 1,
      totals: { total: 5, resolved: 0, resolvedPct: 0 },
      scoreTotals: {
        officialHarness: 0,
        localStructural: 0,
        researchContaminated: 0,
        unlabeledPassed: 0,
        officialResolvedPct: 0,
      },
      proofTotals: {
        submittedWithProof: 0,
        blockedProofMissing: 0,
        blockedEnvFailed: 0,
        contractOnlyBlocked: 0,
        contractOnlySubmitted: 0,
      },
      llmEvidenceTotals: {
        packetizedGenerationCount: 0,
        packetizedRepairCount: 0,
        packetizedSelectionExplanationCount: 0,
      },
      failureBreakdown: { byTermination: {}, bySignal: {} },
      perInstance: [
        unresolvedRow("multi__same", patchForFiles("pkg/a.py", "pkg/b.py")),
        unresolvedRow("multi__partial", patchForFiles("pkg/a.py", "pkg/b.py")),
        unresolvedRow("multi__disjoint", patchForFiles("pkg/x.py")),
        {
          ...unresolvedRow("oracle__bad", patchForFiles("pkg/a.py")),
          reproTest: { installed: false, reason: "execution_failed" },
        },
        unresolvedRow("single__wrong", patchForFiles("pkg/only.py")),
      ],
      knobs: { resolved: {}, inactive: [], preset: "agentless-v3-thin-strict" },
    }),
  )

  writeFileSync(
    join(dir, "coverage-predictions.jsonl"),
    [
      predictionRow("multi__same", "pkg/a.py", "pkg/b.py"),
      predictionRow("multi__partial", "pkg/a.py", "pkg/b.py"),
      predictionRow("multi__disjoint", "pkg/x.py"),
      predictionRow("oracle__bad", "pkg/a.py"),
      predictionRow("single__wrong", "pkg/only.py"),
    ]
      .map((row) => JSON.stringify(row))
      .join("\n"),
  )

  writeFileSync(
    join(dir, "control-report.json"),
    JSON.stringify({
      timestamp: "2026-06-24T00:00:00+09:00",
      model: "gpt-5.4",
      provider: "openai",
      n: 1,
      totals: { total: 3, resolved: 1, resolvedPct: 33 },
      scoreTotals: {
        officialHarness: 1,
        localStructural: 0,
        researchContaminated: 0,
        unlabeledPassed: 0,
        officialResolvedPct: 33,
      },
      proofTotals: {
        submittedWithProof: 0,
        blockedProofMissing: 0,
        blockedEnvFailed: 0,
        contractOnlyBlocked: 0,
        contractOnlySubmitted: 0,
      },
      llmEvidenceTotals: {
        packetizedGenerationCount: 0,
        packetizedRepairCount: 0,
        packetizedSelectionExplanationCount: 0,
      },
      failureBreakdown: { byTermination: {}, bySignal: {} },
      perInstance: [
        {
          id: "case__regression",
          passed: false,
          turns: 1,
          patchBytes: 12,
          gradeBreakdown: {
            resolved: false,
            failToPassFailed: 1,
            passToPassFailed: 2,
            passToPassTotal: 4,
          },
        },
        {
          id: "case__empty",
          passed: false,
          turns: 1,
          patchBytes: 0,
          failure: { termination: "completed_unresolved", signals: ["empty_patch"] },
        },
        {
          id: "case__resolved",
          passed: true,
          turns: 1,
          patchBytes: 10,
          scoreLabel: "official_harness",
          gradeBreakdown: {
            resolved: true,
            failToPassFailed: 0,
            passToPassFailed: 0,
            passToPassTotal: 4,
          },
        },
      ],
      knobs: { resolved: {}, inactive: [], preset: "agentless-v3-thin-strict" },
    }),
  )

  writeFileSync(
    join(dir, "treatment-report.json"),
    JSON.stringify({
      timestamp: "2026-06-24T00:05:00+09:00",
      model: "gpt-5.4",
      provider: "openai",
      n: 1,
      totals: { total: 3, resolved: 1, resolvedPct: 33 },
      scoreTotals: {
        officialHarness: 1,
        localStructural: 0,
        researchContaminated: 0,
        unlabeledPassed: 0,
        officialResolvedPct: 33,
      },
      proofTotals: {
        submittedWithProof: 0,
        blockedProofMissing: 0,
        blockedEnvFailed: 0,
        contractOnlyBlocked: 0,
        contractOnlySubmitted: 0,
      },
      llmEvidenceTotals: {
        packetizedGenerationCount: 0,
        packetizedRepairCount: 0,
        packetizedSelectionExplanationCount: 0,
      },
      failureBreakdown: { byTermination: {}, bySignal: {} },
      perInstance: [
        {
          id: "case__regression",
          passed: false,
          turns: 1,
          patchBytes: 12,
          gradeBreakdown: {
            resolved: false,
            failToPassFailed: 1,
            passToPassFailed: 0,
            passToPassTotal: 4,
          },
        },
        {
          id: "case__empty",
          passed: false,
          turns: 1,
          patchBytes: 15,
          gradeBreakdown: {
            resolved: false,
            failToPassFailed: 1,
            passToPassFailed: 0,
            passToPassTotal: 4,
          },
        },
        {
          id: "case__resolved",
          passed: true,
          turns: 1,
          patchBytes: 10,
          scoreLabel: "official_harness",
          gradeBreakdown: {
            resolved: true,
            failToPassFailed: 0,
            passToPassFailed: 0,
            passToPassTotal: 4,
          },
        },
      ],
      knobs: { resolved: {}, inactive: [], preset: "agentless-v3-thin-strict-execfull" },
    }),
  )

  writeFileSync(
    join(dir, "control-predictions.jsonl"),
    [
      predictionRow("case__regression", "pkg/reg.py"),
      predictionRow("case__empty", "pkg/empty.py"),
      predictionRow("case__resolved", "pkg/resolved.py"),
    ]
      .map((row) => JSON.stringify(row))
      .join("\n"),
  )
  writeFileSync(
    join(dir, "treatment-predictions.jsonl"),
    [
      predictionRow("case__regression", "pkg/reg.py"),
      predictionRow("case__empty", "pkg/empty.py"),
      predictionRow("case__resolved", "pkg/resolved.py"),
    ]
      .map((row) => JSON.stringify(row))
      .join("\n"),
  )
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("wave2 analysis helpers", () => {
  test("A/B rail prefers regression reduction over resolved-count alone", () => {
    const summary = buildWave2AbRail({
      controlReportPath: join(dir, "control-report.json"),
      controlPredictionsPath: join(dir, "control-predictions.jsonl"),
      treatmentReportPath: join(dir, "treatment-report.json"),
      treatmentPredictionsPath: join(dir, "treatment-predictions.jsonl"),
    })

    expect(summary.control.preset).toBe("agentless-v3-thin-strict")
    expect(summary.treatment.preset).toBe("agentless-v3-thin-strict-execfull")
    expect(summary.control.officialResolved).toBe(1)
    expect(summary.treatment.officialResolved).toBe(1)
    expect(summary.regressionReduction).toBe(1)
    expect(summary.emptyPatchDelta).toBe(-1)
    expect(summary.nonEmptyUnresolvedDelta).toBe(1)
  })

  test("coverage census classifies same / partial / disjoint from clean report+predictions inputs", () => {
    const census = buildWave2CoverageCensus({
      datasetPath: join(dir, "dataset.jsonl"),
      reportPath: join(dir, "coverage-report.json"),
      predictionsPath: join(dir, "coverage-predictions.jsonl"),
      minCases: 3,
    })

    expect(census.eligibleCases).toBe(3)
    expect(census.sameFilesWrongFix).toBe(1)
    expect(census.partialOverlap).toBe(1)
    expect(census.disjointLocalization).toBe(1)
    expect(census.entries.map((entry) => entry.instanceId)).toEqual([
      "multi__disjoint",
      "multi__partial",
      "multi__same",
    ])
  })

  test("backlog artifact separates completeness, generation, and oracle buckets", () => {
    const artifact = buildWave2BacklogArtifact({
      datasetPath: join(dir, "dataset.jsonl"),
      reportPath: join(dir, "coverage-report.json"),
      predictionsPath: join(dir, "coverage-predictions.jsonl"),
    })

    expect(artifact.multiSiteCompleteness.map((entry) => entry.instanceId)).toEqual([
      "multi__partial",
    ])
    expect(artifact.generationAccuracy.map((entry) => entry.instanceId)).toEqual([
      "multi__disjoint",
      "multi__same",
      "single__wrong",
    ])
    expect(artifact.oracleQuality).toEqual([
      { instanceId: "oracle__bad", reason: "repro_execution_failed" },
    ])
  })
})
