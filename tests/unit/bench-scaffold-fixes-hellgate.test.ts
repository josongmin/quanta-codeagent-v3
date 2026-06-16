import { describe, expect, test } from "bun:test"
import { applyBenchEnvDefaults } from "@/apps/bench/index"

/**
 * Structural fixes for two bench-scaffold defects that crippled gpt-5.4 on
 * SWE-bench (same model solved the missed instances under mini-swe-agent):
 *
 *   1. per-instance wall-clock deadline counted env setup → ~68% spurious aborts
 *      mid-solve (fixed in driver.ts: timer armed AFTER setup) + default raised
 *      from 2 min to a maxTurns-sized backstop.
 *   2. stale-read freshness guard fired on the agent's OWN sequential edits in
 *      the single-writer sandbox → ~50 `stale_precondition` rejections wasting
 *      turns and blocking the model's own corrections (fixed: default OFF for
 *      bench unless the operator opts in).
 *
 * This locks the #2 contract with teeth (red-on-injection): remove the default
 * and the undefined-case assertion fails.
 */
describe("bench scaffold: stale-read guard default", () => {
  test("undefined → forced 'off' (single-writer sandbox: guard is spurious)", () => {
    const env: Record<string, string | undefined> = {}
    applyBenchEnvDefaults(env)
    expect(env.QUANTA_STALE_READ_GUARD).toBe("off")
  })

  test("explicit operator opt-in is preserved (not clobbered)", () => {
    for (const v of ["1", "on", "off"]) {
      const env: Record<string, string | undefined> = { QUANTA_STALE_READ_GUARD: v }
      applyBenchEnvDefaults(env)
      expect(env.QUANTA_STALE_READ_GUARD).toBe(v)
    }
  })

  test("does not touch unrelated env keys", () => {
    const env: Record<string, string | undefined> = { QUANTA_MODEL: "gpt-5.4" }
    applyBenchEnvDefaults(env)
    expect(env.QUANTA_MODEL).toBe("gpt-5.4")
    expect(env.QUANTA_STALE_READ_GUARD).toBe("off")
  })
})
