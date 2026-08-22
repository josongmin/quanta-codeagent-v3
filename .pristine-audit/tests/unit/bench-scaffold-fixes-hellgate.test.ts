import { describe, expect, test } from "bun:test"
import { applyBenchEnvDefaults } from "@/apps/bench/index"
import {
  CURRENT_BENCH_BASE_PRESET,
  resolveBenchExecutionPreset,
  resolveRemoteBenchExecutionPreset,
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

  // aug-22 HIGH-1 — the family reaches the preset seeder as a TYPED argument off
  // the composition root's resolved BenchRunConfig. It used to be read back out
  // of `env.QUANTA_SWEBENCH_DATASET_FAMILY`, which the root had just written from
  // argv (an in-process authority round-trip through ambient env). The env key is
  // NOT an authority any more, so this asserts both directions.
  test("local Pro defaults to the polyglot-safe preset (TYPED family, not env)", () => {
    const env: Record<string, string | undefined> = {}
    applyBenchEnvDefaults(env, { datasetFamily: "pro" })
    expect(env.QUANTA_BENCH_PRESET).toBe("agentless-v1")
  })

  test("the family ENV key is NOT an authority for preset seeding", () => {
    // env says pro, typed config says verified ⇒ verified wins.
    const envSaysPro: Record<string, string | undefined> = {
      QUANTA_SWEBENCH_DATASET_FAMILY: "pro",
    }
    applyBenchEnvDefaults(envSaysPro, { datasetFamily: "verified" })
    expect(envSaysPro.QUANTA_BENCH_PRESET).toBe(CURRENT_BENCH_BASE_PRESET)
    // env says verified, typed config says pro ⇒ pro wins.
    const envSaysVerified: Record<string, string | undefined> = {
      QUANTA_SWEBENCH_DATASET_FAMILY: "verified",
    }
    applyBenchEnvDefaults(envSaysVerified, { datasetFamily: "pro" })
    expect(envSaysVerified.QUANTA_BENCH_PRESET).toBe("agentless-v1")
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

  test("remote Pro defaults to polyglot-safe v1 but preserves explicit selection", () => {
    expect(resolveRemoteBenchExecutionPreset({ family: "pro", envVars: {} })).toBe("agentless-v1")
    expect(
      resolveRemoteBenchExecutionPreset({
        family: "pro",
        envVars: {},
        argvPreset: "agentless-v3-thin-strict",
      }),
    ).toBe("agentless-v3-thin-strict")
    expect(resolveRemoteBenchExecutionPreset({ family: "verified", envVars: {} })).toBe(
      CURRENT_BENCH_BASE_PRESET,
    )
  })
})
