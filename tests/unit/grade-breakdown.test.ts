/**
 * Hellgate teeth for the grading breakdown parser — the SSOT signal that
 * separates a REGRESSION (patch broke PASS_TO_PASS) from a DIDN'T-FIX (patch
 * left FAIL_TO_PASS failing). A single `resolved:false` conflates these; the
 * regression gate / verify-and-select can only address the former, so the
 * distinction is what justifies (or kills) the gate.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { collectGradeBreakdowns, extractGradeBreakdowns } from "@/apps/bench/python-swebench"

/** Build a harness PER-INSTANCE report object for one instance. */
const perInstanceReport = (
  iid: string,
  f2p: { success: number; failure: number },
  p2p: { success: number; failure: number },
  resolved: boolean,
): Record<string, unknown> => ({
  [iid]: {
    resolved,
    patch_successfully_applied: true,
    tests_status: {
      FAIL_TO_PASS: {
        success: Array.from({ length: f2p.success }, (_, i) => `f2p_pass_${i}`),
        failure: Array.from({ length: f2p.failure }, (_, i) => `f2p_fail_${i}`),
      },
      PASS_TO_PASS: {
        success: Array.from({ length: p2p.success }, (_, i) => `p2p_pass_${i}`),
        failure: Array.from({ length: p2p.failure }, (_, i) => `p2p_fail_${i}`),
      },
    },
  },
})

describe("extractGradeBreakdowns — the regression-vs-didn't-fix signal", () => {
  test("RESOLVED: F2P all pass ∧ P2P all pass", () => {
    const m = extractGradeBreakdowns(
      perInstanceReport(
        "sympy__sympy-1",
        { success: 1, failure: 0 },
        { success: 40, failure: 0 },
        true,
      ),
    )
    expect(m.get("sympy__sympy-1")).toEqual({
      resolved: true,
      failToPassFailed: 0,
      passToPassFailed: 0,
      passToPassTotal: 40,
    })
  })

  test("REGRESSION: P2P has failures (gate-ADDRESSABLE) — the key tooth", () => {
    const m = extractGradeBreakdowns(
      perInstanceReport(
        "sympy__sympy-2",
        { success: 1, failure: 0 },
        { success: 38, failure: 2 },
        false,
      ),
    )
    const b = m.get("sympy__sympy-2")
    expect(b?.resolved).toBe(false)
    expect(b?.passToPassFailed).toBe(2) // broke 2 existing tests → gate would reject
    expect(b?.passToPassTotal).toBe(40)
    expect(b?.failToPassFailed).toBe(0) // it DID fix the target, just regressed
  })

  test("DIDN'T-FIX: F2P fails, P2P green (gate-IRRELEVANT)", () => {
    const m = extractGradeBreakdowns(
      perInstanceReport(
        "sympy__sympy-3",
        { success: 0, failure: 1 },
        { success: 40, failure: 0 },
        false,
      ),
    )
    const b = m.get("sympy__sympy-3")
    expect(b?.resolved).toBe(false)
    expect(b?.passToPassFailed).toBe(0) // NO regression — gate can't help
    expect(b?.failToPassFailed).toBe(1) // simply didn't fix
  })

  // The run-summary report (only resolved_ids, no tests_status) must yield
  // NOTHING — feeding either report shape to the parser is safe.
  test("summary report (resolved_ids, no tests_status) ⇒ empty", () => {
    expect(extractGradeBreakdowns({ resolved_ids: ["a", "b"] }).size).toBe(0)
  })

  test("malformed inputs ⇒ empty (never throws)", () => {
    expect(extractGradeBreakdowns(null).size).toBe(0)
    expect(extractGradeBreakdowns("nope").size).toBe(0)
    expect(extractGradeBreakdowns({ x: { tests_status: 7 } }).size).toBe(0)
    expect(extractGradeBreakdowns({ x: { tests_status: {} } }).get("x")).toEqual({
      resolved: false,
      failToPassFailed: 0,
      passToPassFailed: 0,
      passToPassTotal: 0,
    })
  })
})

describe("collectGradeBreakdowns — recursive scan of the harness work dir", () => {
  let work: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "grade-"))
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  test("finds the NESTED per-instance report.json (logs/run_evaluation/…)", async () => {
    const nested = join(work, "logs", "run_evaluation", "run1", "quanta", "sympy__sympy-9")
    mkdirSync(nested, { recursive: true })
    writeFileSync(
      join(nested, "report.json"),
      JSON.stringify(
        perInstanceReport(
          "sympy__sympy-9",
          { success: 1, failure: 0 },
          { success: 10, failure: 3 },
          false,
        ),
      ),
    )
    // also drop a summary report at the root — must be tolerated, contributes nothing
    writeFileSync(join(work, "summary.json"), JSON.stringify({ resolved_ids: [] }))
    const m = await collectGradeBreakdowns(work)
    expect(m.get("sympy__sympy-9")?.passToPassFailed).toBe(3)
  })

  test("missing dir ⇒ empty map (fail-open)", async () => {
    const m = await collectGradeBreakdowns(join(work, "does-not-exist"))
    expect(m.size).toBe(0)
    expect(existsSync(join(work, "does-not-exist"))).toBe(false)
  })
})
