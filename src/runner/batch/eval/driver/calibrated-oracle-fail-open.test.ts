import { describe, expect, test } from "bun:test"
import type { ReproOracleCalibration } from "../../types"
import { calibratedOracleMustFailOpen } from "./selection-port-factories"

/**
 * B2 — the calibrated repro-consensus port must fail-OPEN (never REJECT a
 * candidate) whenever the oracle is untrustworthy. The original guard covered
 * only `falseNegative` (oracle can't recognize the gold fix). It MISSED the
 * symmetric pathology: a VACUOUS oracle (`vacuous` — reports RESOLVED on the
 * un-patched BASE tree) false-GREENs EVERY candidate, so its "resolved" votes are
 * meaningless and could SELECT a wrong candidate. Both untrustworthy modes must
 * fail open.
 */
const cal = (over: Partial<ReproOracleCalibration>): ReproOracleCalibration => ({
  goldCalibrated: true,
  falseNegative: false,
  available: true,
  goldVotes: 1,
  goldK: 1,
  baseResolved: false,
  vacuous: false,
  baseVotes: 0,
  baseK: 1,
  ...over,
})

describe("B2 calibratedOracleMustFailOpen — vacuous fail-open", () => {
  test("falseNegative ⇒ fail-open (pre-existing invariant)", () => {
    expect(calibratedOracleMustFailOpen(cal({ falseNegative: true }))).toBe(true)
  })

  test("VACUOUS (resolves on base) ⇒ fail-open (B2 — meaningless-green oracle can't select)", () => {
    // gold ALSO resolves (it resolves everything) ⇒ falseNegative:false, but the
    // oracle is worthless: base is already "resolved".
    expect(
      calibratedOracleMustFailOpen(cal({ vacuous: true, baseResolved: true, falseNegative: false })),
    ).toBe(true)
  })

  test("healthy oracle (recognizes gold, RED on base) ⇒ use live oracle (no fail-open)", () => {
    expect(calibratedOracleMustFailOpen(cal({ falseNegative: false, vacuous: false }))).toBe(false)
  })
})
