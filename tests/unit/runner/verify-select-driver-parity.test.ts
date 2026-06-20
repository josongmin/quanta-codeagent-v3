import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")
const DRIVER_SRC = readFileSync(join(REPO_ROOT, "src/runner/batch/eval/driver.ts"), "utf8")

describe("runner verify-select and patch-budget driver parity", () => {
  test("runner driver executes verify-select instead of silently ignoring the knob", () => {
    expect(DRIVER_SRC).toContain("const runSelectionPhase = async")
    expect(DRIVER_SRC).toContain("posture.verifySelectN !== undefined && instance.swebench !== undefined")
    expect(DRIVER_SRC).toContain("posture.verifySelectConcurrency")
    expect(DRIVER_SRC).toContain("posture.verifySelectRegression")
    expect(DRIVER_SRC).toContain("posture.verifySelectRepro")
    expect(DRIVER_SRC).toContain("reproOracleCalibration: calibration")
    expect(DRIVER_SRC).toContain("selectionTelemetry: summarizeSelection(result)")
  })

  test("runner driver emits patch-budget telemetry when the knob is on", () => {
    expect(DRIVER_SRC).toContain('import { analyzePatchBudget } from "@/agent/patch-budget"')
    expect(DRIVER_SRC).toContain("if (posture.patchBudget && instance.swebench !== undefined)")
    expect(DRIVER_SRC).toContain("extra.patchBudget = analyzePatchBudget(phase.patch, {")
  })
})
