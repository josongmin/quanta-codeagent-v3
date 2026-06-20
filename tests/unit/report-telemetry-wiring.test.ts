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
import { buildReport } from "@/runner/batch/report"
import type {
  GradeBreakdown,
  InstanceResult,
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
      candidates: [
        {
          id: "cand-0",
          files: ["symptom.py"],
          admissible: false,
          score: 0.2,
          reasons: ["hard:regressionGreen=false"],
        },
        {
          id: "cand-1",
          files: ["root.py"],
          admissible: true,
          score: 0.9,
          reasons: ["soft:ownerCoverage=1"],
        },
      ],
    }
    const rep = buildReport(meta, [baseResult({ selectionTelemetry: t })])
    expect(rep.perInstance[0]?.selectionTelemetry).toEqual(t)
  })

  // Byte-identical contract: absent telemetry ⇒ keys omitted (not null).
  test("absent telemetry ⇒ keys omitted (byte-identical)", () => {
    const rep = buildReport(meta, [baseResult({})])
    expect("gradeBreakdown" in (rep.perInstance[0] ?? {})).toBe(false)
    expect("reproOracleCalibration" in (rep.perInstance[0] ?? {})).toBe(false)
    expect("selectionTelemetry" in (rep.perInstance[0] ?? {})).toBe(false)
  })
})
