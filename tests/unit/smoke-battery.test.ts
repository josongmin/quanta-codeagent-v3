// meta-test: drives the tests/smoke/* battery (lives outside src/, no @/ alias).
import { afterAll, describe, expect, test } from "bun:test"
import { discoverScenarios, runScenario } from "../smoke/runner"

/** Pending-record scenarios are allowed but must stay visible — not buried in green. */
const MAX_ALLOWED_SKIPS = 8

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
    if (skipped.length === 0) return
    const lines = skipped.map((s) => `  - ${s.depth}/${s.id}: ${s.reason}`)
    console.warn(
      `\n[smoke-battery] ${skipped.length} scenario(s) skipped (pending trajectory):\n${lines.join("\n")}\n`,
    )
    if (skipped.length > MAX_ALLOWED_SKIPS) {
      throw new Error(
        `[smoke-battery] too many skipped scenarios (${skipped.length} > ${MAX_ALLOWED_SKIPS}). ` +
          "Record trajectories or raise MAX_ALLOWED_SKIPS with an ADR rationale.",
      )
    }
  })
})
