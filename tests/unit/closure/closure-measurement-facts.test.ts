import { describe, expect, test } from "bun:test"
import { buildFacts } from "@/runner/batch/eval/closure-diagnostics-io"
import type { InstanceResult } from "@/runner/batch/types"

/**
 * T-3 measurement instrumentation — buildFacts maps the closure signals the
 * driver emits (primaryRailPresent / requiredVerificationCovered) into
 * ClosureRunFact, so the offline diagnostics produce primary_rail_present_rate /
 * required_verification_coverage.
 *
 * Red-on-injection: drop the mapping in buildFacts ⇒ facts carry `undefined`
 * (not the emitted value) ⇒ these fail.
 * Absent signal ⇒ null (metric UNAVAILABLE, never a false "false").
 */
const res = (over: Partial<InstanceResult>): InstanceResult => ({
  id: "x__1",
  passed: false,
  patch: "",
  turns: 1,
  ...over,
})

describe("buildFacts — closure measurement signals", () => {
  test("emitted signals are mapped through to the fact", () => {
    const facts = buildFacts([res({ primaryRailPresent: true, requiredVerificationCovered: true })])
    const f = facts[0]
    expect(f?.primaryRailPresent).toBe(true)
    expect(f?.requiredVerificationCovered).toBe(true)
  })

  test("false signal is preserved (rail computed but absent ⇒ false, not null)", () => {
    const facts = buildFacts([res({ primaryRailPresent: false, requiredVerificationCovered: false })])
    expect(facts[0]?.primaryRailPresent).toBe(false)
    expect(facts[0]?.requiredVerificationCovered).toBe(false)
  })

  test("absent signal ⇒ null (metric unavailable, NOT a false signal)", () => {
    const facts = buildFacts([res({})])
    expect(facts[0]?.primaryRailPresent).toBeNull()
    expect(facts[0]?.requiredVerificationCovered).toBeNull()
  })

  test("primaryFalseGreen flows through (true / false / absent⇒null)", () => {
    // red-on-injection: drop the `primaryFalseGreen` mapping in buildFacts ⇒ these fail.
    expect(buildFacts([res({ primaryFalseGreen: true })])[0]?.primaryFalseGreen).toBe(true)
    expect(buildFacts([res({ primaryFalseGreen: false })])[0]?.primaryFalseGreen).toBe(false)
    expect(buildFacts([res({})])[0]?.primaryFalseGreen).toBeNull()
  })

  test("gateEntered flows through (true / false / absent⇒null)", () => {
    expect(buildFacts([res({ gateEntered: true })])[0]?.gateEntered).toBe(true)
    expect(buildFacts([res({ gateEntered: false })])[0]?.gateEntered).toBe(false)
    expect(buildFacts([res({})])[0]?.gateEntered).toBeNull()
  })
})
