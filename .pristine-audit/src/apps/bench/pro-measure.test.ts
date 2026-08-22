import { describe, expect, test } from "bun:test"
import {
  filterPythonProIds,
  planResumeChunks,
  tallyMeasurement,
  vsExternalLine,
} from "./pro-measure"

describe("filterPythonProIds — addressable Python-Pro subset", () => {
  const rows = [
    { instance_id: "ansible__a-1", repo: "ansible/ansible", repo_language: "python" },
    { instance_id: "ol__o-1", repo: "internetarchive/openlibrary", repo_language: "Python" },
    { instance_id: "flipt__f-1", repo: "flipt-io/flipt", repo_language: "go" },
    { instance_id: "nodebb__n-1", repo: "NodeBB/NodeBB", repo_language: "js" },
    { instance_id: "qb__q-1", repo: "qutebrowser/qutebrowser", repo_language: "python" },
    { instance_id: "bad", repo: "x/y" }, // no language ⇒ excluded
  ]
  test("keeps ONLY python rows (case-insensitive), drops go/js/missing", () => {
    expect(filterPythonProIds(rows)).toEqual(["ansible__a-1", "ol__o-1", "qb__q-1"])
  })
  test("empty ⇒ empty (fail-safe)", () => {
    expect(filterPythonProIds([])).toEqual([])
  })
})

describe("planResumeChunks — chunk remainder, skip already-graded", () => {
  test("skips done ids; chunks the rest in order; no dup, no done", () => {
    const all = ["a", "b", "c", "d", "e"]
    const done = new Set(["b", "d"])
    expect(planResumeChunks(all, done, 2)).toEqual([["a", "c"], ["e"]])
  })
  test("all done ⇒ no chunks (campaign complete)", () => {
    expect(planResumeChunks(["a", "b"], new Set(["a", "b"]), 3)).toEqual([])
  })
  test("chunkSize >= remaining ⇒ single chunk", () => {
    expect(planResumeChunks(["a", "b"], new Set(), 10)).toEqual([["a", "b"]])
  })
})

describe("tallyMeasurement — solvability-gated denominator + Wilson 95% CI", () => {
  // grader_invalid / env_prep_failed / degraded = measurement-holes ⇒ EXCLUDED from denominator
  // (never counted as model misses — the platform's #1 rule). resolved = passed among measurable.
  const outcomes = [
    { id: "1", passed: true }, // measurable resolved
    { id: "2", passed: false }, // measurable miss
    { id: "3", passed: false, verdict: "grader_invalid" as const }, // HOLE — excluded
    { id: "4", passed: true }, // measurable resolved
    { id: "5", passed: false, verdict: "env_prep_failed" as const }, // HOLE — excluded
  ]
  test("excludes holes from denominator; resolved/measurable computed honestly", () => {
    const t = tallyMeasurement(outcomes)
    expect(t.measurable).toBe(3) // 1,2,4 (3+5 excluded)
    expect(t.resolved).toBe(2) // 1,4
    expect(t.holes).toBe(2) // 3,5
    expect(t.ratePct).toBe(67) // 2/3 = 66.7 → 67
  })
  test("naive vs honest gap is real: naive would be 2/5=40%, honest 2/3=67%", () => {
    const t = tallyMeasurement(outcomes)
    expect(t.ratePct).not.toBe(40) // not the naive total-as-denominator number
  })
  test("Wilson 95% CI brackets the point estimate, within [0,100], lo<=hi", () => {
    const t = tallyMeasurement(outcomes)
    expect(t.ci95[0]).toBeGreaterThanOrEqual(0)
    expect(t.ci95[1]).toBeLessThanOrEqual(100)
    expect(t.ci95[0]).toBeLessThanOrEqual(t.ratePct)
    expect(t.ratePct).toBeLessThanOrEqual(t.ci95[1])
    expect(t.ci95[0]).toBeLessThanOrEqual(t.ci95[1])
  })
  test("zero measurable (all holes) ⇒ rate 0, CI [0,0], no NaN/divide-by-zero", () => {
    const t = tallyMeasurement([{ id: "x", passed: false, verdict: "grader_invalid" as const }])
    expect(t.measurable).toBe(0)
    expect(t.ratePct).toBe(0)
    expect(Number.isNaN(t.ci95[0])).toBe(false)
    expect(Number.isNaN(t.ci95[1])).toBe(false)
  })
  test("wider CI for small n: 2/3 has a wide interval (proof n=5 is not measurement)", () => {
    const t = tallyMeasurement(outcomes)
    expect(t.ci95[1] - t.ci95[0]).toBeGreaterThan(40) // n=3 ⇒ huge uncertainty
  })
})

describe("vsExternalLine — our number next to external SOTA (population-honest)", () => {
  test("shows BOTH populations + a not-comparable caveat (ours=Python-266, ext=full-731)", () => {
    const line = vsExternalLine(67, 59.1, "gpt-5.4 (xHigh)")
    expect(line).toContain("67%")
    expect(line).toContain("59")
    expect(line).toContain("gpt-5.4 (xHigh)")
    // MEASUREMENT VALIDITY: ours is the Python-266 subset, external SOTA is the FULL 731
    // (incl. go/js/ts). The line MUST flag they're different populations so "67% vs 59%" is
    // never misread as "we beat SOTA".
    expect(line.toLowerCase()).toContain("python-266")
    expect(line.toLowerCase()).toContain("731")
    expect(line).toMatch(/not.*comparable|different population|⚠/i)
  })
  test("no external ⇒ graceful, no false comparison", () => {
    const line = vsExternalLine(67, undefined, undefined)
    expect(line).toContain("67%")
    expect(line).not.toMatch(/vs|beat/i)
  })
})
