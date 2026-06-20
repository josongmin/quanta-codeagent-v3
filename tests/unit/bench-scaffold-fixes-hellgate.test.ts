import { describe, expect, test } from "bun:test"
import { applyBenchEnvDefaults } from "@/apps/bench/index"
import {
  CURRENT_BENCH_BASE_PRESET,
  resolveBenchExecutionPreset,
} from "@/apps/bench/preset"

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
    expect(env.QUANTA_BENCH_PRESET).toBe(CURRENT_BENCH_BASE_PRESET)
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
    expect(env.QUANTA_BENCH_PRESET).toBe(CURRENT_BENCH_BASE_PRESET)
  })

  test("explicit preset selectors are preserved instead of clobbered by the new default", () => {
    const envPreset: Record<string, string | undefined> = { QUANTA_BENCH_PRESET: "agentless-v2" }
    applyBenchEnvDefaults(envPreset)
    expect(envPreset.QUANTA_BENCH_PRESET).toBe("agentless-v2")

    const sotaAlias: Record<string, string | undefined> = { QUANTA_BENCH_SOTA: "1" }
    applyBenchEnvDefaults(sotaAlias)
    expect(sotaAlias.QUANTA_BENCH_PRESET).toBeUndefined()

    const legacyPreset: Record<string, string | undefined> = {
      QUANTA_KNOBS_PRESET: "agentless-v3-select-regression",
    }
    applyBenchEnvDefaults(legacyPreset)
    expect(legacyPreset.QUANTA_BENCH_PRESET).toBeUndefined()
  })

  test("argv --preset seeds local bench runs when env selectors are absent", () => {
    const env: Record<string, string | undefined> = {}
    applyBenchEnvDefaults(env, { argvPreset: "agentless-v3-select-regression" })
    expect(env.QUANTA_BENCH_PRESET).toBe("agentless-v3-select-regression")
  })
})

describe("bench execution preset resolution", () => {
  test("remote/pool default resolves to the current base profile", () => {
    expect(resolveBenchExecutionPreset({ envVars: {} })).toBe(CURRENT_BENCH_BASE_PRESET)
  })

  test("env selector precedence stays stable across execution surfaces", () => {
    expect(
      resolveBenchExecutionPreset({
        envVars: {
          QUANTA_BENCH_PRESET: "agentless-v2",
          QUANTA_BENCH_SOTA: "1",
          QUANTA_KNOBS_PRESET: "baseline",
        },
        argvPreset: "agentless-v3-thin-strict",
      }),
    ).toBe("agentless-v2")
    expect(
      resolveBenchExecutionPreset({
        envVars: { QUANTA_BENCH_SOTA: "1" },
        argvPreset: "agentless-v3-thin",
      }),
    ).toBe("agentless-v1")
  })
})
