import { describe, expect, test } from "bun:test"
import type { InstanceResult } from "../types"
import { resolvedTotals } from "../observe"
import { isSwebenchInfraGradeFailure, swebenchGraderInvalidVerdict } from "./driver"

// RFC jun-29 #2: a swebench main-grade INFRA failure (verify set `error` on a non-pass =
// harness gradingCompleted:false / refuse-to-fake-grade) is a measurement hole, marked
// grader_invalid so resolvedTotals EXCLUDES it. A genuine patch-fail (no error) is a real
// miss and MUST stay counted. This pins the throttle-miss-confound fence.
const swebench = { swebench: { instanceId: "x", repo: "r", baseCommit: "c" } }

describe("isSwebenchInfraGradeFailure (#2 measurement-hole fence)", () => {
  test("swebench + !passed + error ⇒ true (infra hole → will be excluded)", () => {
    expect(isSwebenchInfraGradeFailure(swebench, { passed: false, error: "Pro harness not wired" })).toBe(true)
    expect(isSwebenchInfraGradeFailure(swebench, { passed: false, error: "pro harness invocation failed" })).toBe(true)
  })

  // PAIRED CONTROL — the genuine miss: same !passed, but NO error ⇒ a real model miss
  // that MUST stay in the denominator. Kills any mutant that excludes real misses.
  test("genuine patch-fail (!passed, NO error) ⇒ false (real_miss stays counted)", () => {
    expect(isSwebenchInfraGradeFailure(swebench, { passed: false })).toBe(false)
  })

  test("resolved (passed) ⇒ false", () => {
    expect(isSwebenchInfraGradeFailure(swebench, { passed: true, error: undefined })).toBe(false)
  })

  test("non-swebench instance ⇒ false (a local-testCmd error is NOT this infra signal)", () => {
    expect(isSwebenchInfraGradeFailure({ swebench: undefined }, { passed: false, error: "test failed" })).toBe(false)
  })
})

// WIRING (audit driver-BUG-1): the predicate alone proved nothing — the chain
// predicate → buildSuccessfulResultExtra sets verdict="grader_invalid" → resolvedTotals
// EXCLUDES it was untested, so a mutant dropping the infra branch stayed green. These pin
// both remaining links via the extracted decision fn + the resolvedTotals consumer.
describe("swebenchGraderInvalidVerdict (predicate → verdict wiring)", () => {
  test("infra failure ⇒ 'grader_invalid'", () => {
    expect(swebenchGraderInvalidVerdict(false, swebench, { passed: false, error: "Pro harness not wired" })).toBe(
      "grader_invalid",
    )
  })
  test("gold-sanity graderInvalid ⇒ 'grader_invalid' (covers its own case)", () => {
    expect(swebenchGraderInvalidVerdict(true, swebench, { passed: true })).toBe("grader_invalid")
  })
  test("genuine miss (!passed, NO error, not gold-invalid) ⇒ undefined (stays counted)", () => {
    expect(swebenchGraderInvalidVerdict(false, swebench, { passed: false })).toBeUndefined()
  })
  test("resolved ⇒ undefined", () => {
    expect(swebenchGraderInvalidVerdict(false, swebench, { passed: true })).toBeUndefined()
  })
})

describe("resolvedTotals EXCLUDES grader_invalid (denominator contract)", () => {
  const r = (id: string, passed: boolean, verdict?: InstanceResult["verdict"]): InstanceResult =>
    ({ id, passed, turns: 1, verdict }) as InstanceResult

  test("an infra hole leaves BOTH numerator and denominator; a genuine miss stays in the denominator", () => {
    const genuineMiss = r("a", false) // verdict undefined ⇒ "ok" ⇒ counted
    const infraHole = r("b", false, "grader_invalid") // excluded
    const passing = r("c", true)
    // Paired control: with the infra hole present vs replaced by a genuine miss.
    const withHole = resolvedTotals([passing, genuineMiss, infraHole])
    expect(withHole).toEqual({ resolved: 1, total: 2, degraded: 1 })
    // TEETH: if grader_invalid were NOT excluded, total would be 3 (the laundering we forbid).
    expect(withHole.total).not.toBe(3)
    const allGenuine = resolvedTotals([passing, genuineMiss, r("b", false)])
    expect(allGenuine.total).toBe(3) // same rows, hole reclassified as miss ⇒ now counted
  })
})
