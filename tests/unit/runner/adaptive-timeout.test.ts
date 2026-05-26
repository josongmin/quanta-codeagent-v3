/**
 * Adaptive-timeout unit tests — pure projection contract.
 *
 * The function under test (`computeAdaptedTimeout`) consumes a base timeout
 * + a `BenchKnobState` and returns `baseMs * Σ(active knob costMultipliers)`
 * clamped to `[baseMs, MAX_TIMEOUT_MS]`. The pure-projection contract is
 * the load-bearing piece: every test below pins one branch in isolation.
 *
 * No bench, no LLM, no fs — these tests are registry-mutating only when
 * registering test-local knobs (the registry is reset per-test).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import {
  computeAdaptedTimeout,
  MAX_TIMEOUT_MS,
  sumCostMultipliers,
} from "@/runner/batch/eval/adaptive-timeout"
import type { BenchKnobState } from "@/runner/batch/eval/knobs-bench"
import { resolveBenchKnobs } from "@/runner/batch/eval/knobs-bench"
import { __resetRegistry, type Knob, registerKnob, type Surface } from "@/runner/knobs"

const BENCH: readonly Surface[] = ["bench"]

const noopApply = (cfg: AgentConfig): AgentConfig => cfg

const mkKnob = (id: string, envKey: string, costMultiplier?: number): Knob<true> => {
  const base: Knob<true> = {
    id,
    envKey,
    category: "agent",
    surfaces: BENCH,
    parse: (raw: string | undefined): true | undefined => (raw === "1" ? true : undefined),
    apply: (cfg: AgentConfig, _v: true): AgentConfig => noopApply(cfg),
    describe: `test knob ${id}`,
  }
  return costMultiplier !== undefined ? { ...base, costMultiplier } : base
}

const ENV_KEYS = [
  "QUANTA_BENCH_TEST_A",
  "QUANTA_BENCH_TEST_B",
  "QUANTA_BENCH_TEST_C",
  "QUANTA_BENCH_TEST_GARBAGE",
]

let savedEnv: Map<string, string | undefined>

const snapEnv = (): Map<string, string | undefined> => {
  const m = new Map<string, string | undefined>()
  for (const k of ENV_KEYS) m.set(k, process.env[k])
  return m
}

const restoreEnv = (m: Map<string, string | undefined>): void => {
  for (const [k, v] of m) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

beforeEach(() => {
  savedEnv = snapEnv()
  for (const k of ENV_KEYS) delete process.env[k]
  __resetRegistry()
})

afterEach(() => {
  restoreEnv(savedEnv)
  __resetRegistry()
})

const baseMs = 600_000 // 10 min, matches QUANTA_BENCH_TIMEOUT_MS default

describe("sumCostMultipliers — pure projection", () => {
  test("empty registry ⇒ returns 1 (byte-identical sentinel)", () => {
    const state = resolveBenchKnobs({ envVars: process.env })
    expect(state.values.size).toBe(0)
    expect(sumCostMultipliers(state)).toBe(1)
  })

  test("single active knob with costMultiplier=3 ⇒ sum is 3", () => {
    registerKnob(mkKnob("test-a", "QUANTA_BENCH_TEST_A", 3))
    process.env.QUANTA_BENCH_TEST_A = "1"
    const state = resolveBenchKnobs({ envVars: process.env })
    expect(sumCostMultipliers(state)).toBe(3)
  })

  test("two active knobs (costs 3 + 5) ⇒ sum is 8", () => {
    registerKnob(mkKnob("test-a", "QUANTA_BENCH_TEST_A", 3))
    registerKnob(mkKnob("test-b", "QUANTA_BENCH_TEST_B", 5))
    process.env.QUANTA_BENCH_TEST_A = "1"
    process.env.QUANTA_BENCH_TEST_B = "1"
    const state = resolveBenchKnobs({ envVars: process.env })
    expect(sumCostMultipliers(state)).toBe(8)
  })

  test("knob without costMultiplier field ⇒ contributes 1 (default)", () => {
    registerKnob(mkKnob("test-a", "QUANTA_BENCH_TEST_A")) // no costMultiplier
    process.env.QUANTA_BENCH_TEST_A = "1"
    const state = resolveBenchKnobs({ envVars: process.env })
    expect(sumCostMultipliers(state)).toBe(1)
  })

  test("garbage costMultiplier (NaN / Infinity / negative / 0) ⇒ contributes 1", () => {
    registerKnob(mkKnob("test-a", "QUANTA_BENCH_TEST_A", Number.NaN))
    registerKnob(mkKnob("test-b", "QUANTA_BENCH_TEST_B", Number.POSITIVE_INFINITY))
    registerKnob(mkKnob("test-c", "QUANTA_BENCH_TEST_C", -5))
    process.env.QUANTA_BENCH_TEST_A = "1"
    process.env.QUANTA_BENCH_TEST_B = "1"
    process.env.QUANTA_BENCH_TEST_C = "1"
    const state = resolveBenchKnobs({ envVars: process.env })
    // 3 active knobs, each contributing 1 ⇒ sum 3
    expect(sumCostMultipliers(state)).toBe(3)
  })

  test("registered knob with NO env value ⇒ NOT active ⇒ not counted", () => {
    registerKnob(mkKnob("test-a", "QUANTA_BENCH_TEST_A", 3))
    // No env var set
    const state = resolveBenchKnobs({ envVars: process.env })
    expect(state.values.size).toBe(0)
    expect(sumCostMultipliers(state)).toBe(1)
  })
})

describe("computeAdaptedTimeout — baseline (byte-identical fence)", () => {
  test("empty registry ⇒ returns baseMs unchanged", () => {
    const state = resolveBenchKnobs({ envVars: process.env })
    expect(computeAdaptedTimeout(baseMs, state)).toBe(baseMs)
  })

  test("registered-but-inactive knobs ⇒ baseMs unchanged", () => {
    registerKnob(mkKnob("test-a", "QUANTA_BENCH_TEST_A", 3))
    const state = resolveBenchKnobs({ envVars: process.env })
    expect(state.values.size).toBe(0)
    expect(computeAdaptedTimeout(baseMs, state)).toBe(baseMs)
  })

  test("single knob with costMultiplier=1 ⇒ baseMs * 1 == baseMs", () => {
    registerKnob(mkKnob("test-a", "QUANTA_BENCH_TEST_A", 1))
    process.env.QUANTA_BENCH_TEST_A = "1"
    const state = resolveBenchKnobs({ envVars: process.env })
    expect(computeAdaptedTimeout(baseMs, state)).toBe(baseMs)
  })
})

describe("computeAdaptedTimeout — scaling", () => {
  test("branch-search K=3 (costMultiplier=3) ⇒ 3× baseMs", () => {
    registerKnob(mkKnob("branch-search", "QUANTA_BENCH_BRANCH_SEARCH", 3))
    process.env.QUANTA_BENCH_BRANCH_SEARCH = "1"
    const state = resolveBenchKnobs({ envVars: process.env })
    expect(computeAdaptedTimeout(baseMs, state)).toBe(baseMs * 3)
  })

  test("repro-test K=5 (costMultiplier=5) ⇒ 5× smaller-baseMs (avoid cap)", () => {
    registerKnob(mkKnob("repro-test", "QUANTA_BENCH_REPRO_TEST", 5))
    process.env.QUANTA_BENCH_REPRO_TEST = "1"
    const state = resolveBenchKnobs({ envVars: process.env })
    // 5min * 5 = 25min < MAX (30min)
    expect(computeAdaptedTimeout(5 * 60_000, state)).toBe(25 * 60_000)
  })

  test("two knobs (cost 3 + cost 2) ⇒ smallerBase * 5 (sum, not product)", () => {
    registerKnob(mkKnob("test-a", "QUANTA_BENCH_TEST_A", 3))
    registerKnob(mkKnob("test-b", "QUANTA_BENCH_TEST_B", 2))
    process.env.QUANTA_BENCH_TEST_A = "1"
    process.env.QUANTA_BENCH_TEST_B = "1"
    const state = resolveBenchKnobs({ envVars: process.env })
    // 5min * (3+2) = 25min < MAX
    expect(computeAdaptedTimeout(5 * 60_000, state)).toBe(25 * 60_000)
  })

  test("multi-knob sum saturated at MAX when product would exceed", () => {
    registerKnob(mkKnob("test-a", "QUANTA_BENCH_TEST_A", 3))
    registerKnob(mkKnob("test-b", "QUANTA_BENCH_TEST_B", 2))
    process.env.QUANTA_BENCH_TEST_A = "1"
    process.env.QUANTA_BENCH_TEST_B = "1"
    const state = resolveBenchKnobs({ envVars: process.env })
    // baseMs (10min) * 5 = 50min > MAX (30min) ⇒ clamped
    expect(computeAdaptedTimeout(baseMs, state)).toBe(MAX_TIMEOUT_MS)
  })
})

describe("computeAdaptedTimeout — MAX_TIMEOUT_MS cap", () => {
  test("MAX_TIMEOUT_MS = 30 * 60 * 1000 (30 minutes)", () => {
    expect(MAX_TIMEOUT_MS).toBe(30 * 60 * 1000)
  })

  test("baseMs * costMult > MAX ⇒ clamped to MAX (30 min)", () => {
    registerKnob(mkKnob("test-a", "QUANTA_BENCH_TEST_A", 10))
    process.env.QUANTA_BENCH_TEST_A = "1"
    const state = resolveBenchKnobs({ envVars: process.env })
    // 600_000 * 10 = 6_000_000ms > MAX_TIMEOUT_MS (1_800_000ms)
    expect(computeAdaptedTimeout(baseMs, state)).toBe(MAX_TIMEOUT_MS)
  })

  test("baseMs = 5min, K=3 ⇒ 15 min (under MAX)", () => {
    registerKnob(mkKnob("test-a", "QUANTA_BENCH_TEST_A", 3))
    process.env.QUANTA_BENCH_TEST_A = "1"
    const state = resolveBenchKnobs({ envVars: process.env })
    const result = computeAdaptedTimeout(5 * 60_000, state)
    expect(result).toBe(15 * 60_000)
    expect(result).toBeLessThan(MAX_TIMEOUT_MS)
  })

  test("baseMs at MAX boundary, K=2 ⇒ still clamped to MAX", () => {
    registerKnob(mkKnob("test-a", "QUANTA_BENCH_TEST_A", 2))
    process.env.QUANTA_BENCH_TEST_A = "1"
    const state = resolveBenchKnobs({ envVars: process.env })
    expect(computeAdaptedTimeout(MAX_TIMEOUT_MS, state)).toBe(MAX_TIMEOUT_MS)
  })
})

describe("computeAdaptedTimeout — defensive parsing", () => {
  test("baseMs = 0 ⇒ returns 0 (fail-fast posture)", () => {
    const state = resolveBenchKnobs({ envVars: process.env })
    expect(computeAdaptedTimeout(0, state)).toBe(0)
  })

  test("baseMs negative ⇒ returns 0", () => {
    const state = resolveBenchKnobs({ envVars: process.env })
    expect(computeAdaptedTimeout(-500, state)).toBe(0)
  })

  test("baseMs NaN ⇒ returns 0", () => {
    const state = resolveBenchKnobs({ envVars: process.env })
    expect(computeAdaptedTimeout(Number.NaN, state)).toBe(0)
  })

  test("baseMs Infinity ⇒ returns 0", () => {
    const state = resolveBenchKnobs({ envVars: process.env })
    expect(computeAdaptedTimeout(Number.POSITIVE_INFINITY, state)).toBe(0)
  })

  test("hypothetical costMultiplier < 1 ⇒ floor at 1 (never shrink baseMs)", () => {
    // Direct test bypassing knob registration — use a hand-crafted state.
    const fakeState = {
      knobs: new Map([
        [
          "tiny",
          {
            id: "tiny",
            envKey: "X",
            category: "agent",
            surfaces: ["bench"],
            parse: () => undefined,
            apply: (c: AgentConfig) => c,
            describe: "x",
            costMultiplier: 0.1,
          } as unknown as Knob,
        ],
      ]),
      values: new Map([["tiny", { value: true, source: "env" as const }]]),
      preset: undefined,
      inactive: [],
    } as unknown as BenchKnobState
    // Even with 0.1 multiplier, adapted >= baseMs (never shrinks).
    expect(computeAdaptedTimeout(baseMs, fakeState)).toBe(baseMs)
  })

  test("knob garbage costMultiplier + multiple active ⇒ each contributes 1", () => {
    registerKnob(mkKnob("test-a", "QUANTA_BENCH_TEST_A", Number.NaN))
    registerKnob(mkKnob("test-b", "QUANTA_BENCH_TEST_B", 4))
    process.env.QUANTA_BENCH_TEST_A = "1"
    process.env.QUANTA_BENCH_TEST_B = "1"
    const state = resolveBenchKnobs({ envVars: process.env })
    // NaN ⇒ 1, valid 4 ⇒ 4; sum = 5; baseMs=5min ⇒ 25min < MAX
    expect(computeAdaptedTimeout(5 * 60_000, state)).toBe(25 * 60_000)
  })
})
