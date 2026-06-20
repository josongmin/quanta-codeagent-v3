import { describe, expect, test } from "bun:test"
import { selectionReproPolicy } from "@/apps/bench/eval/driver"
import { benchPostureFromState, resolveBenchKnobs } from "@/runner/batch/eval/knobs-bench"
import "@/runner/knobs/knobs"

const posture = (env: Record<string, string>) =>
  benchPostureFromState(resolveBenchKnobs({ envVars: env }), env)

describe("verify-select-regression knob wiring", () => {
  test("unset preserves legacy regression source selection", () => {
    expect(posture({}).verifySelectRegression).toBeUndefined()
  })

  test("discovered mode reaches BenchPosture", () => {
    const p = posture({ QUANTA_BENCH_VERIFY_SELECT_REGRESSION: "discovered" })
    expect(p.verifySelectRegression).toBe("discovered")
  })

  test("gold and off modes reach BenchPosture for eval and ablation arms", () => {
    expect(posture({ QUANTA_BENCH_VERIFY_SELECT_REGRESSION: "gold" }).verifySelectRegression).toBe(
      "gold",
    )
    expect(posture({ QUANTA_BENCH_VERIFY_SELECT_REGRESSION: "off" }).verifySelectRegression).toBe(
      "off",
    )
  })
})

describe("verify-select-repro knob wiring", () => {
  test("unset preserves legacy hard resolved-consensus mode", () => {
    expect(posture({}).verifySelectRepro).toBeUndefined()
  })

  test("positive and off modes reach BenchPosture", () => {
    expect(posture({ QUANTA_BENCH_VERIFY_SELECT_REPRO: "positive" }).verifySelectRepro).toBe(
      "positive",
    )
    expect(posture({ QUANTA_BENCH_VERIFY_SELECT_REPRO: "off" }).verifySelectRepro).toBe("off")
  })
})

describe("selectionReproPolicy", () => {
  test("positive mode is soft-only and does not gold-calibrate", () => {
    expect(selectionReproPolicy("positive")).toEqual({
      enabled: true,
      goldCalibrate: false,
      resolvedKofNMode: "soft",
    })
  })

  test("unset/hard preserves the eval-only gold-calibrated hard gate", () => {
    expect(selectionReproPolicy(undefined)).toEqual({
      enabled: true,
      goldCalibrate: true,
      resolvedKofNMode: "hard",
    })
    expect(selectionReproPolicy("hard")).toEqual({
      enabled: true,
      goldCalibrate: true,
      resolvedKofNMode: "hard",
    })
  })

  test("off disables the repro selection signal entirely", () => {
    expect(selectionReproPolicy("off")).toEqual({
      enabled: false,
      goldCalibrate: false,
      resolvedKofNMode: "hard",
    })
  })
})
