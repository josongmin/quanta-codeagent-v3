// meta-test: drives the tests/smoke/* battery (lives outside src/, no @/ alias).
import { afterAll, describe, expect, test } from "bun:test"
import { discoverScenarios, runScenario } from "../smoke/runner"

/**
 * FLAG 3 — skip budget is a DOWNWARD RATCHET, not a fixed slack allowance.
 * Pending-record scenarios are tolerated but must stay visible (per-skip
 * `console.warn` below) AND cannot grow: re-introducing a skip for an
 * already-recorded scenario fails the suite.
 *
 * Baseline = the actual skip count of the battery as checked in. This number
 * must only ever go DOWN (record a trajectory ⇒ lower it). Raising it requires
 * an explicit edit here with rationale — it is not a free knob.
 *
 * Baseline as of 2026-06-25: 0 skips (all 15 fixtures have a trajectory.jsonl).
 */
const SKIP_BASELINE = 0

/**
 * Folds the tier-0 smoke battery into the main `bun test` gate (RFC §1.2).
 * Scenarios without `trajectory.jsonl` skip (pending recording) but are summarized
 * after the suite so coverage gaps do not hide behind an all-green run.
 */
describe("smoke battery (tier-0 replay)", () => {
  const scenarios = discoverScenarios()
  const skipped: Array<{ id: string; depth: string; reason: string }> = []

  test("at least one scenario is discoverable", () => {
    expect(scenarios.length).toBeGreaterThan(0)
  })

  for (const meta of scenarios) {
    test(`${meta.depth}/${meta.id}`, async () => {
      const result = await runScenario(meta)
      if (result.status === "skipped") {
        expect(result.skipReason).toBeDefined()
        skipped.push({
          id: meta.id,
          depth: meta.depth,
          reason: result.skipReason ?? "(no reason)",
        })
        return
      }
      if (result.status === "failed") {
        const detail = result.failures
          .map((f) => `  ${f.path}: expected ${f.expected}, got ${f.actual}`)
          .join("\n")
        throw new Error(`smoke scenario ${meta.id} failed:\n${detail}`)
      }
      expect(result.status).toBe("passed")
    })
  }

  afterAll(() => {
    if (skipped.length > 0) {
      const lines = skipped.map((s) => `  - ${s.depth}/${s.id}: ${s.reason}`)
      console.warn(
        `\n[smoke-battery] ${skipped.length} scenario(s) skipped (pending trajectory):\n${lines.join("\n")}\n`,
      )
    }
    assertSkipsWithinBaseline(skipped.length)
  })
})

/** FLAG 3 ratchet rule, extracted so it has direct unit teeth (the battery's
 *  afterAll only exercises the happy path where 0 scenarios skip). Throws when
 *  the observed skip count exceeds the checked-in baseline. */
export const assertSkipsWithinBaseline = (count: number, baseline = SKIP_BASELINE): void => {
  if (count > baseline) {
    throw new Error(
      `[smoke-battery] skip count regressed (${count} > baseline ${baseline}). ` +
        "Skips may only go DOWN: record the missing trajectory.jsonl, or — if a skip is " +
        "genuinely unavoidable — raise SKIP_BASELINE here with a dated rationale.",
    )
  }
}

describe("smoke battery — skip ratchet (FLAG 3)", () => {
  test("skip count over baseline fails (teeth)", () => {
    // Pre-fix the budget was a fixed slack of 8; re-introducing a skip for an
    // already-recorded scenario passed silently. Now any growth past baseline throws.
    expect(() => assertSkipsWithinBaseline(SKIP_BASELINE + 1)).toThrow(/skip count regressed/)
  })

  test("skip count at or below baseline passes (control)", () => {
    expect(() => assertSkipsWithinBaseline(SKIP_BASELINE)).not.toThrow()
    expect(() => assertSkipsWithinBaseline(0, 3)).not.toThrow()
  })
})
