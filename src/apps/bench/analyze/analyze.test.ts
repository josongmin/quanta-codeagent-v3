/**
 * ADR-0536 P0 — bench ANALYSIS layer tests (PURE).
 *
 * Covers all four modules with inline fixtures for BOTH report shapes. Each
 * test asserts a real observable (set membership, file-set divergence, dedup
 * outcome) and includes a red-on-injection partner where the prompt asks for
 * it, so a vacuous/over-permissive implementation fails here.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { diffRuns, renderDiff } from "./diff"
import { explainFailure, filesInDiff } from "./explain"
import { type LeaderRow, renderLeaderboardMarkdown, rowsFromRun } from "./leaderboard"
import { loadVerdicts, loadVerdictsFromFile } from "./verdicts"
import {
  ANSWER_KEY_CLEAN_AFTER,
  assertWave2BenchReportProvenance,
  loadWave2VerdictsFromFile,
  modelPatchFromPredictionArtifact,
} from "./wave2-guards"

// ── verdicts: both shapes normalise to the same RunVerdicts ────────────────

describe("loadVerdicts — both report shapes", () => {
  const ourReport = {
    timestamp: "2026-06-15T00:00:00Z",
    model: "m",
    provider: "p",
    n: 4,
    totals: { total: 4, resolved: 1, resolvedPct: 25 },
    scoreTotals: {
      officialHarness: 1,
      localStructural: 0,
      researchContaminated: 0,
      unlabeledPassed: 0,
      officialResolvedPct: 25,
    },
    perInstance: [
      {
        id: "django__django-1",
        passed: true,
        turns: 3,
        patchBytes: 120,
        scoreLabel: "official_harness",
        scoreEvidence: {
          officialHarnessResolved: true,
          localExecutedGreen: true,
          researchKnobTouched: false,
        },
      },
      {
        id: "django__django-2",
        passed: false,
        turns: 5,
        patchBytes: 40,
        proofState: "proof_missing",
        proofRequiredMissing: true,
        contractOnlyBlocked: true,
        failure: { termination: "admission_blocked", signals: [] },
      }, // unresolved in our report shape too
      {
        id: "django__django-3",
        passed: false,
        turns: 0,
        patchBytes: 0,
        failure: { termination: "completed_unresolved", signals: ["empty_patch"] },
      },
      {
        id: "django__django-4",
        passed: false,
        turns: 2,
        patchBytes: 10,
        error: "boom",
        failure: { termination: "harness_error", signals: [] },
      },
    ],
    knobs: { resolved: {}, inactive: [] },
  }

  const harnessReport = {
    total_instances: 4,
    resolved_instances: 1,
    unresolved_instances: 1,
    error_instances: 1,
    empty_patch_instances: 1,
    resolved_ids: ["django__django-1"],
    unresolved_ids: ["django__django-2"],
    error_ids: ["django__django-4"],
    empty_patch_ids: ["django__django-3"],
  }

  test("our bench report → correct official + failure buckets", () => {
    const v = loadVerdicts(ourReport)
    expect([...v.resolved]).toEqual(["django__django-1"])
    expect([...v.localStructural]).toEqual([])
    expect([...v.researchContaminated]).toEqual([])
    expect([...v.proofMissing]).toEqual(["django__django-2"])
    expect([...v.contractOnlyBlocked]).toEqual(["django__django-2"])
    expect([...v.infraBlocked]).toEqual([])
    expect([...v.unresolved]).toEqual(["django__django-2"])
    expect([...v.emptyPatch]).toEqual(["django__django-3"])
    expect([...v.errored]).toEqual(["django__django-4"])
    expect(v.reportTotals).toEqual({
      submittedWithProof: 0,
      blockedProofMissing: 1,
      blockedEnvFailed: 0,
      contractOnlyBlocked: 1,
      contractOnlySubmitted: 0,
      packetizedGenerationCount: null,
      packetizedRepairCount: null,
      packetizedSelectionExplanationCount: null,
    })
  })

  test("passing rows with weaker score labels stay out of official resolved", () => {
    const v = loadVerdicts({
      ...ourReport,
      perInstance: [
        {
          id: "django__django-local",
          passed: true,
          turns: 2,
          patchBytes: 10,
          scoreLabel: "local_structural",
        },
        {
          id: "django__django-research",
          passed: true,
          turns: 2,
          patchBytes: 10,
          scoreLabel: "research_contaminated",
        },
      ],
    })
    expect([...v.resolved]).toEqual([])
    expect([...v.localStructural]).toEqual(["django__django-local"])
    expect([...v.researchContaminated]).toEqual(["django__django-research"])
  })

  test("legacy fallback: gradeBreakdown-resolved stays official; unlabeled pass without breakdown stays local", () => {
    const v = loadVerdicts({
      ...ourReport,
      perInstance: [
        {
          id: "django__django-harness-legacy",
          passed: true,
          turns: 1,
          patchBytes: 12,
          gradeBreakdown: {
            resolved: true,
            failToPassFailed: 0,
            passToPassFailed: 0,
            passToPassTotal: 40,
          },
        },
        {
          id: "django__django-local-legacy",
          passed: true,
          turns: 1,
          patchBytes: 12,
        },
      ],
    })
    expect([...v.resolved]).toEqual(["django__django-harness-legacy"])
    expect([...v.localStructural]).toEqual(["django__django-local-legacy"])
    expect([...v.researchContaminated]).toEqual([])
  })

  test("typed admission_blocked stays unresolved, not errored", () => {
    const v = loadVerdicts(ourReport)
    expect(v.unresolved.has("django__django-2")).toBe(true)
    expect(v.errored.has("django__django-2")).toBe(false)
    expect(v.emptyPatch.has("django__django-2")).toBe(false)
  })

  test("typed timeout stays errored, not emptyPatch", () => {
    const v = loadVerdicts({
      ...ourReport,
      perInstance: [
        {
          id: "django__django-timeout",
          passed: false,
          turns: 7,
          patchBytes: 0,
          failure: { termination: "timeout", signals: ["empty_patch"] },
        },
      ],
    })
    expect(v.errored.has("django__django-timeout")).toBe(true)
    expect(v.emptyPatch.has("django__django-timeout")).toBe(false)
    expect(v.unresolved.has("django__django-timeout")).toBe(false)
  })

  test("typed hung_stream stays errored, not emptyPatch", () => {
    const v = loadVerdicts({
      ...ourReport,
      perInstance: [
        {
          id: "django__django-hung",
          passed: false,
          turns: 0,
          patchBytes: 0,
          failure: { termination: "hung_stream", signals: ["empty_patch"] },
        },
      ],
    })
    expect(v.errored.has("django__django-hung")).toBe(true)
    expect(v.emptyPatch.has("django__django-hung")).toBe(false)
    expect(v.unresolved.has("django__django-hung")).toBe(false)
  })

  test("typed grader_invalid stays errored, not unresolved", () => {
    const v = loadVerdicts({
      ...ourReport,
      perInstance: [
        {
          id: "django__django-grader",
          passed: false,
          turns: 0,
          patchBytes: 12,
          failure: { termination: "grader_invalid", signals: [] },
        },
      ],
    })
    expect(v.errored.has("django__django-grader")).toBe(true)
    expect(v.emptyPatch.has("django__django-grader")).toBe(false)
    expect(v.unresolved.has("django__django-grader")).toBe(false)
  })

  test("typed generation_error stays errored, not emptyPatch", () => {
    const v = loadVerdicts({
      ...ourReport,
      perInstance: [
        {
          id: "django__django-generation",
          passed: false,
          turns: 0,
          patchBytes: 0,
          failure: { termination: "generation_error", signals: ["empty_patch"] },
        },
      ],
    })
    expect(v.errored.has("django__django-generation")).toBe(true)
    expect(v.emptyPatch.has("django__django-generation")).toBe(false)
    expect(v.unresolved.has("django__django-generation")).toBe(false)
  })

  test("harness report → correct four buckets", () => {
    const v = loadVerdicts(harnessReport)
    expect([...v.resolved]).toEqual(["django__django-1"])
    expect([...v.localStructural]).toEqual([])
    expect([...v.researchContaminated]).toEqual([])
    expect([...v.unresolved]).toEqual(["django__django-2"])
    expect([...v.emptyPatch]).toEqual(["django__django-3"])
    expect([...v.errored]).toEqual(["django__django-4"])
  })

  test("duplicate harness ids keep one strongest bucket per instance", () => {
    const v = loadVerdicts({
      resolved_ids: ["demo__1"],
      unresolved_ids: ["demo__1", "demo__2"],
      error_ids: ["demo__2", "demo__3"],
      empty_patch_ids: ["demo__3", "demo__4"],
    })
    expect([...v.resolved]).toEqual(["demo__1"])
    expect([...v.unresolved]).toEqual(["demo__2"])
    expect([...v.errored]).toEqual(["demo__3"])
    expect([...v.emptyPatch]).toEqual(["demo__4"])
  })

  test("both shapes yield equivalent RunVerdicts for equivalent data", () => {
    const a = loadVerdicts(ourReport)
    const b = loadVerdicts(harnessReport)
    for (const k of [
      "resolved",
      "localStructural",
      "researchContaminated",
      "unresolved",
      "emptyPatch",
      "errored",
    ] as const) {
      expect([...a[k]].sort()).toEqual([...b[k]].sort())
    }
  })

  test("red-on-injection: a passing instance is NEVER counted unresolved", () => {
    const v = loadVerdicts(ourReport)
    expect(v.unresolved.has("django__django-1")).toBe(false)
    expect(v.resolved.has("django__django-1")).toBe(true)
  })

  test("harness *_ids may be JSON-encoded strings (double-encoded export)", () => {
    const v = loadVerdicts({ resolved_ids: '["a__1","b__2"]', unresolved_ids: [] })
    expect([...v.resolved].sort()).toEqual(["a__1", "b__2"])
  })

  test("unrecognised shape throws", () => {
    expect(() => loadVerdicts({ nope: 1 })).toThrow()
    expect(() => loadVerdicts(null)).toThrow()
  })

  test("loadVerdictsFromFile reads + parses", () => {
    const dir = mkdtempSync(join(tmpdir(), "verdicts-"))
    const p = join(dir, "report.json")
    writeFileSync(p, JSON.stringify(harnessReport))
    const v = loadVerdictsFromFile(p)
    expect([...v.resolved]).toEqual(["django__django-1"])
  })

  test("wave2 provenance guard accepts answer-key-clean bench reports", () => {
    const clean = {
      ...ourReport,
      timestamp: ANSWER_KEY_CLEAN_AFTER,
      knobs: { resolved: {}, inactive: [], preset: "agentless-v3-thin-strict" },
    }
    expect(() => assertWave2BenchReportProvenance(clean, "clean-report")).not.toThrow()
  })

  test("wave2 provenance guard rejects old or underspecified reports", () => {
    expect(
      () =>
        assertWave2BenchReportProvenance(
          {
            ...ourReport,
            knobs: { resolved: {}, inactive: [], preset: "agentless-v3-thin-strict" },
          },
          "old-report",
        ),
    ).toThrow(
      /predates answer-key-clean-after/,
    )
    expect(() =>
      assertWave2BenchReportProvenance(
        {
          ...ourReport,
          timestamp: ANSWER_KEY_CLEAN_AFTER,
          knobs: { resolved: {}, inactive: [] },
        },
        "missing-preset",
      ),
    ).toThrow(/missing knobs\.preset/)
  })

  test("loadWave2VerdictsFromFile validates provenance before diff inputs are loaded", () => {
    const dir = mkdtempSync(join(tmpdir(), "wave2-verdicts-"))
    const p = join(dir, "report.json")
    writeFileSync(
      p,
      JSON.stringify({
        ...ourReport,
        timestamp: ANSWER_KEY_CLEAN_AFTER,
        knobs: { resolved: {}, inactive: [], preset: "agentless-v3-thin-strict" },
      }),
    )
    const loaded = loadWave2VerdictsFromFile(p)
    expect([...loaded.verdicts.resolved]).toEqual(["django__django-1"])
    expect(loaded.report.knobs).toEqual({
      resolved: {},
      inactive: [],
      preset: "agentless-v3-thin-strict",
    })
  })

  test("top-level proofTotals and llmEvidenceTotals win when present", () => {
    const v = loadVerdicts({
      ...ourReport,
      proofTotals: {
        submittedWithProof: 7,
        blockedProofMissing: 3,
        blockedEnvFailed: 2,
        contractOnlyBlocked: 5,
        contractOnlySubmitted: 1,
      },
      llmEvidenceTotals: {
        packetizedGenerationCount: 9,
        packetizedRepairCount: 4,
        packetizedSelectionExplanationCount: 2,
      },
      perInstance: [
        {
          id: "django__django-proof",
          passed: false,
          turns: 3,
          patchBytes: 12,
          proofRequiredMissing: true,
          submittedCandidateProof: true,
          llmEvidenceStages: ["candidate_generation", "repair_seed", "selection_explanation"],
          failure: { termination: "completed_unresolved", signals: [] },
        },
      ],
    })
    expect(v.reportTotals).toEqual({
      submittedWithProof: 7,
      blockedProofMissing: 3,
      blockedEnvFailed: 2,
      contractOnlyBlocked: 5,
      contractOnlySubmitted: 1,
      packetizedGenerationCount: 9,
      packetizedRepairCount: 4,
      packetizedSelectionExplanationCount: 2,
    })
  })

  test("packet totals stay unknown when an old report lacks top-level llmEvidenceTotals", () => {
    const v = loadVerdicts({
      ...ourReport,
      perInstance: [
        {
          id: "django__django-old-packet-report",
          passed: false,
          turns: 3,
          patchBytes: 12,
          llmEvidenceStages: ["candidate_generation", "repair_seed"],
          failure: { termination: "completed_unresolved", signals: [] },
        },
      ],
    })
    expect(v.reportTotals).toEqual({
      submittedWithProof: null,
      blockedProofMissing: null,
      blockedEnvFailed: null,
      contractOnlyBlocked: null,
      contractOnlySubmitted: null,
      packetizedGenerationCount: null,
      packetizedRepairCount: null,
      packetizedSelectionExplanationCount: null,
    })
  })

  test("duplicate perInstance rows keep the strongest verdict and dedupe fallback proof totals", () => {
    const v = loadVerdicts({
      ...ourReport,
      proofTotals: undefined,
      perInstance: [
        {
          id: "demo__same",
          passed: false,
          patchBytes: 0,
          submittedCandidateProof: true,
          failure: { termination: "completed_unresolved", signals: ["empty_patch"] },
        },
        {
          id: "demo__same",
          passed: true,
          patchBytes: 20,
          submittedCandidateProof: true,
          scoreLabel: "official_harness",
        },
        {
          id: "demo__other",
          passed: false,
          patchBytes: 0,
          proofRequiredMissing: true,
          failure: { termination: "completed_unresolved", signals: [] },
        },
      ],
    })
    expect([...v.resolved]).toEqual(["demo__same"])
    expect([...v.emptyPatch]).toEqual(["demo__other"])
    expect(v.unresolved.has("demo__same")).toBe(false)
    expect([...v.unresolved]).toEqual([])
    expect(v.reportTotals).toEqual({
      submittedWithProof: 1,
      blockedProofMissing: 1,
      blockedEnvFailed: 0,
      contractOnlyBlocked: 0,
      contractOnlySubmitted: 0,
      packetizedGenerationCount: null,
      packetizedRepairCount: null,
      packetizedSelectionExplanationCount: null,
    })
  })

  test("duplicate perInstance rows derive proof-missing telemetry from the canonical row only", () => {
    const v = loadVerdicts({
      ...ourReport,
      proofTotals: undefined,
      perInstance: [
        {
          id: "demo__same",
          passed: false,
          patchBytes: 0,
          proofRequiredMissing: true,
          failure: { termination: "completed_unresolved", signals: ["empty_patch"] },
        },
        {
          id: "demo__same",
          passed: true,
          patchBytes: 20,
          scoreLabel: "official_harness",
        },
      ],
    })
    expect([...v.resolved]).toEqual(["demo__same"])
    expect([...v.proofMissing]).toEqual([])
    expect(v.reportTotals).toEqual({
      submittedWithProof: 0,
      blockedProofMissing: 0,
      blockedEnvFailed: 0,
      contractOnlyBlocked: 0,
      contractOnlySubmitted: 0,
      packetizedGenerationCount: null,
      packetizedRepairCount: null,
      packetizedSelectionExplanationCount: null,
    })
  })
})

// ── diff: A resolved {x,y}, B resolved {y,z} ───────────────────────────────

describe("diffRuns", () => {
  const mk = (resolved: string[], rest: string[] = []) => ({
    resolved: new Set(resolved),
    localStructural: new Set<string>(),
    researchContaminated: new Set<string>(),
    unresolved: new Set(rest),
    errored: new Set<string>(),
    emptyPatch: new Set<string>(),
  })

  test("newlyResolved [z], newlyBroken [x], stillResolved [y]", () => {
    const a = mk(["x", "y"], ["z"])
    const b = mk(["y", "z"], ["x"])
    const d = diffRuns(a, b)
    expect(d.newlyResolved).toEqual(["z"])
    expect(d.newlyBroken).toEqual(["x"])
    expect(d.stillResolved).toEqual(["y"])
    expect(d.resolvedA).toBe(2)
    expect(d.resolvedB).toBe(2)
    // union {x,y,z} = 3 instances, delta 0 → 0%
    expect(d.deltaPct).toBe(0)
  })

  test("deltaPct reflects a real improvement", () => {
    // A resolves 0/3, B resolves 2/3 → +2/3 ≈ +67%
    const a = mk([], ["x", "y", "z"])
    const b = mk(["x", "y"], ["z"])
    const d = diffRuns(a, b)
    expect(d.deltaPct).toBe(67)
  })

  test("red-on-injection: an instance resolved in BOTH is never newlyBroken/newlyResolved", () => {
    const a = mk(["y"])
    const b = mk(["y"])
    const d = diffRuns(a, b)
    expect(d.newlyResolved).toEqual([])
    expect(d.newlyBroken).toEqual([])
    expect(d.stillResolved).toEqual(["y"])
  })

  test("renderDiff surfaces every section", () => {
    const out = renderDiff(diffRuns(mk(["x", "y"]), mk(["y", "z"])))
    expect(out).toContain("newly resolved")
    expect(out).toContain("z")
    expect(out).toContain("newly broken")
    expect(out).toContain("x")
    expect(out).toContain("still resolved")
  })

  test("renderDiff surfaces authority and packet telemetry deltas when present", () => {
    const a = {
      ...mk(["x"]),
      reportTotals: {
        submittedWithProof: 1,
        blockedProofMissing: 3,
        blockedEnvFailed: 2,
        contractOnlyBlocked: 4,
        contractOnlySubmitted: 1,
        packetizedGenerationCount: 0,
        packetizedRepairCount: 0,
        packetizedSelectionExplanationCount: 0,
      },
    }
    const b = {
      ...mk(["x", "y"]),
      reportTotals: {
        submittedWithProof: 2,
        blockedProofMissing: 1,
        blockedEnvFailed: 1,
        contractOnlyBlocked: 2,
        contractOnlySubmitted: 0,
        packetizedGenerationCount: 8,
        packetizedRepairCount: 3,
        packetizedSelectionExplanationCount: 8,
      },
    }
    const out = renderDiff(diffRuns(a, b))
    expect(out).toContain("authority/proof telemetry:")
    expect(out).toContain("submittedWithProof: A=1  B=2  delta=+1")
    expect(out).toContain("blockedProofMissing: A=3  B=1  delta=-2")
    expect(out).toContain("packet coverage:")
    expect(out).toContain("packetizedGenerationCount: A=0  B=8  delta=+8")
    expect(out).toContain("packetizedRepairCount: A=0  B=3  delta=+3")
  })

  test("renderDiff keeps missing telemetry unknown instead of coercing it to zero", () => {
    const a = mk(["x"])
    const b = {
      ...mk(["x"]),
      reportTotals: {
        submittedWithProof: 2,
        blockedProofMissing: 1,
        blockedEnvFailed: 0,
        contractOnlyBlocked: 0,
        contractOnlySubmitted: 0,
        packetizedGenerationCount: 5,
        packetizedRepairCount: 2,
        packetizedSelectionExplanationCount: 1,
      },
    }
    const out = renderDiff(diffRuns(a, b))
    expect(out).toContain("submittedWithProof: A=unknown  B=2  delta=unknown")
    expect(out).toContain("packetizedGenerationCount: A=unknown  B=5  delta=unknown")
  })

  test("throttle/infra-miss in B is NOT a regression — bucketed as unmeasured", () => {
    // A resolved {X, Y, Z}. In B: X errored (throttle/harness), Y empty-patch,
    // Z genuinely unresolved-with-patch. Only Z is a real regression.
    const a = {
      resolved: new Set(["X", "Y", "Z"]),
      localStructural: new Set<string>(),
      researchContaminated: new Set<string>(),
      unresolved: new Set<string>(),
      errored: new Set<string>(),
      emptyPatch: new Set<string>(),
    }
    const b = {
      resolved: new Set<string>(),
      localStructural: new Set<string>(),
      researchContaminated: new Set<string>(),
      unresolved: new Set(["Z"]),
      errored: new Set(["X"]),
      emptyPatch: new Set(["Y"]),
    }
    const d = diffRuns(a, b)
    expect(d.newlyBroken).toEqual(["Z"])
    expect(d.newlyBroken).not.toContain("X")
    expect(d.newlyBroken).not.toContain("Y")
    expect([...d.bUnmeasured].sort()).toEqual(["X", "Y"])
    const out = renderDiff(d)
    expect(out).toContain("unmeasured")
    expect(out).toContain("X")
    expect(out).toContain("Y")
  })
})

// ── explain: agent touched the right file but wrong algorithm ───────────────

describe("filesInDiff", () => {
  test("extracts b/<path> from diff --git headers", () => {
    const patch = [
      "diff --git a/pylint/foo.py b/pylint/foo.py",
      "--- a/pylint/foo.py",
      "+++ b/pylint/foo.py",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "diff --git a/pylint/bar.py b/pylint/bar.py",
      "+z",
    ].join("\n")
    expect(filesInDiff(patch)).toEqual(["pylint/foo.py", "pylint/bar.py"])
  })

  test("empty / non-diff patch → []", () => {
    expect(filesInDiff("")).toEqual([])
    expect(filesInDiff("just some text\nno headers")).toEqual([])
  })
})

describe("explainFailure", () => {
  const writeDataset = (): { datasetPath: string } => {
    const dir = mkdtempSync(join(tmpdir(), "explain-"))
    const goldPatch = [
      "diff --git a/pylint/checkers/format.py b/pylint/checkers/format.py",
      "+gold change A",
      "diff --git a/pylint/checkers/utils.py b/pylint/checkers/utils.py",
      "+gold change B",
    ].join("\n")
    const testPatch = [
      "diff --git a/tests/test_format.py b/tests/test_format.py",
      "+def test_thing(): assert True",
    ].join("\n")
    const row = {
      instance_id: "pylint-dev__pylint-8898",
      patch: goldPatch,
      test_patch: testPatch,
      FAIL_TO_PASS: '["tests/test_format.py::test_thing"]',
    }
    const datasetPath = join(dir, "instances.jsonl")
    writeFileSync(datasetPath, `${JSON.stringify(row)}\n`)
    return { datasetPath }
  }

  test("agent touched only 1 of 2 gold files → sameFiles=false, FAIL_TO_PASS surfaced", () => {
    const { datasetPath } = writeDataset()
    const agentPatch =
      "diff --git a/pylint/checkers/format.py b/pylint/checkers/format.py\n+agent change"
    const e = explainFailure({
      datasetPath,
      instanceId: "pylint-dev__pylint-8898",
      agentPatch,
    })
    expect(e.goldFiles).toEqual(["pylint/checkers/format.py", "pylint/checkers/utils.py"])
    expect(e.agentFiles).toEqual(["pylint/checkers/format.py"])
    expect(e.sameFiles).toBe(false)
    expect(e.failToPass).toEqual(["tests/test_format.py::test_thing"])
    expect(e.summary).toContain("tests/test_format.py::test_thing")
    expect(e.summary).toContain("PARTIAL OVERLAP")
  })

  test("same-file-set (right file, wrong algorithm) → sameFiles=true and a clear verdict", () => {
    const { datasetPath } = writeDataset()
    // Agent touched EXACTLY the two gold files but still failed.
    const agentPatch = [
      "diff --git a/pylint/checkers/format.py b/pylint/checkers/format.py",
      "+wrong algo",
      "diff --git a/pylint/checkers/utils.py b/pylint/checkers/utils.py",
      "+wrong algo",
    ].join("\n")
    const e = explainFailure({
      datasetPath,
      instanceId: "pylint-dev__pylint-8898",
      agentPatch,
    })
    expect(e.sameFiles).toBe(true)
    expect(e.summary).toContain("SAME FILE SET")
  })

  test("no agent patch → agentFiles [], sameFiles false", () => {
    const { datasetPath } = writeDataset()
    const e = explainFailure({ datasetPath, instanceId: "pylint-dev__pylint-8898" })
    expect(e.agentPatch).toBeUndefined()
    expect(e.agentFiles).toEqual([])
    expect(e.sameFiles).toBe(false)
  })

  test("agentPatchPath is read from disk when no inline patch given", () => {
    const { datasetPath } = writeDataset()
    const dir = mkdtempSync(join(tmpdir(), "agent-"))
    const agentPatchPath = join(dir, "agent.patch")
    writeFileSync(
      agentPatchPath,
      "diff --git a/pylint/checkers/format.py b/pylint/checkers/format.py\n+x",
    )
    const e = explainFailure({
      datasetPath,
      instanceId: "pylint-dev__pylint-8898",
      agentPatchPath,
    })
    expect(e.agentFiles).toEqual(["pylint/checkers/format.py"])
  })

  test("prediction artifact path resolves model_patch for the requested instance", () => {
    const dir = mkdtempSync(join(tmpdir(), "predictions-"))
    const predictionsPath = join(dir, "predictions.jsonl")
    writeFileSync(
      predictionsPath,
      [
        JSON.stringify({
          instance_id: "other__1",
          model_name_or_path: "gpt-5.4",
          model_patch: "diff --git a/other.py b/other.py\n+x",
        }),
        JSON.stringify({
          instance_id: "pylint-dev__pylint-8898",
          model_name_or_path: "gpt-5.4",
          modelPatch:
            "diff --git a/pylint/checkers/format.py b/pylint/checkers/format.py\n+x\n",
        }),
      ].join("\n"),
    )
    expect(
      modelPatchFromPredictionArtifact({
        artifactPath: predictionsPath,
        instanceId: "pylint-dev__pylint-8898",
      }),
    ).toContain("pylint/checkers/format.py")
  })

  test("dataset row supplied as a prediction artifact is rejected fail-closed", () => {
    const dir = mkdtempSync(join(tmpdir(), "predictions-dataset-"))
    const badPath = join(dir, "dataset.jsonl")
    writeFileSync(
      badPath,
      `${JSON.stringify({
        instance_id: "pylint-dev__pylint-8898",
        base_commit: "deadbeef",
        patch: "diff --git a/pylint/checkers/format.py b/pylint/checkers/format.py\n+x",
        FAIL_TO_PASS: ["tests/test_format.py::test_thing"],
      })}\n`,
    )
    expect(() =>
      explainFailure({
        datasetPath: writeDataset().datasetPath,
        instanceId: "pylint-dev__pylint-8898",
        agentPatchPath: badPath,
      }),
    ).toThrow(/dataset-shaped row supplied/)
  })

  test("missing instance throws", () => {
    const { datasetPath } = writeDataset()
    expect(() => explainFailure({ datasetPath, instanceId: "nope__1" })).toThrow()
  })
})

// ── leaderboard: dedup keeps resolved when same instance appears twice ──────

describe("renderLeaderboardMarkdown", () => {
  test("rowsFromRun derives repo from instanceId and score status", () => {
    const rows = rowsFromRun(
      {
        resolved: new Set(["django__django-1"]),
        localStructural: new Set(["flask__flask-9"]),
        researchContaminated: new Set<string>(),
        unresolved: new Set<string>(),
        errored: new Set<string>(),
        emptyPatch: new Set<string>(),
      },
      { preset: "agentless-v1", model: "gpt-5" },
    )
    const byId = new Map(rows.map((r) => [r.instanceId, r]))
    expect(byId.get("django__django-1")?.repo).toBe("django")
    expect(byId.get("django__django-1")?.status).toBe("official_harness")
    expect(byId.get("flask__flask-9")?.repo).toBe("flask")
    expect(byId.get("flask__flask-9")?.status).toBe("local_structural")
  })

  test("dedup keeps strongest status when an instance appears multiple times", () => {
    const rows: LeaderRow[] = [
      {
        instanceId: "x__1",
        repo: "x",
        preset: "a",
        model: "m",
        status: "research_contaminated",
      },
      {
        instanceId: "x__1",
        repo: "x",
        preset: "b",
        model: "m",
        status: "official_harness",
      },
    ]
    const md = renderLeaderboardMarkdown(rows)
    expect(md).toContain("Official harness resolved: 1 / 1")
    const [, official = "", local = "", research = "", unresolved = ""] = md.split(
      /## (?:Official Harness|Local Structural|Research Contaminated|Unresolved)/,
    )
    expect(official).toContain("x__1")
    expect(local).not.toContain("x__1")
    expect(research).not.toContain("x__1")
    expect(unresolved).not.toContain("x__1")
  })

  test("red-on-injection: local structural does NOT promote to official harness", () => {
    const rows: LeaderRow[] = [
      {
        instanceId: "y__2",
        repo: "y",
        preset: "a",
        model: "m",
        status: "local_structural",
      },
    ]
    const md = renderLeaderboardMarkdown(rows)
    expect(md).toContain("Official harness resolved: 0 / 1")
    expect(md).toContain("Local structural only: 1")
  })
})
