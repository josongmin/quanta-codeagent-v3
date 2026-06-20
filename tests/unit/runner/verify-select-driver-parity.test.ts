import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")
const DRIVER_SRC = readFileSync(join(REPO_ROOT, "src/runner/batch/eval/driver.ts"), "utf8")
const APP_DRIVER_SRC = readFileSync(join(REPO_ROOT, "src/apps/bench/eval/driver.ts"), "utf8")

describe("runner verify-select and patch-budget driver parity", () => {
  test("runner driver executes verify-select instead of silently ignoring the knob", () => {
    expect(DRIVER_SRC).toContain("const runSelectionPhase = async")
    expect(DRIVER_SRC).toContain(
      "posture.verifySelectN !== undefined && instance.swebench !== undefined",
    )
    expect(DRIVER_SRC).toContain("posture.verifySelectConcurrency")
    expect(DRIVER_SRC).toContain("posture.verifySelectEarlyAccept")
    expect(DRIVER_SRC).toContain("posture.verifySelectRegression")
    expect(DRIVER_SRC).toContain("posture.verifySelectRepro")
    expect(DRIVER_SRC).toContain("reproOracleCalibration: calibration")
    expect(DRIVER_SRC).toContain("selectionTelemetry: summarizeSelection(result)")
    expect(DRIVER_SRC).toContain("result.terminalCandidate?.stopReason")
    expect(APP_DRIVER_SRC).toContain("result.terminalCandidate?.stopReason")
    expect(DRIVER_SRC).toContain("candidatePatchAppliesCleanly")
    expect(DRIVER_SRC).toContain("applyClean: (c) =>")
  })

  test("both drivers preserve empty max-turns as a terminal classification signal", () => {
    expect(DRIVER_SRC).toContain('phase.stopReason === "max_turns" && phase.patch.trim() === ""')
    expect(APP_DRIVER_SRC).toContain(
      'phase.stopReason === "max_turns" && phase.patch.trim() === ""',
    )
  })

  test("verify-select owner seeds come from ClosureBundle evidence in both drivers", () => {
    const expected =
      "closureSession?.bundle.evidence.candidates.map((c) => c.file) ?? localizeCandidates"
    expect(DRIVER_SRC).toContain(expected)
    expect(APP_DRIVER_SRC).toContain(expected)
  })

  test("runner driver emits patch-budget telemetry when the knob is on", () => {
    expect(DRIVER_SRC).toContain("buildPhasePatchBudget,")
    expect(DRIVER_SRC).toContain(
      "if ((posture.patchBudget || posture.patchBudgetStrict) && instance.swebench !== undefined)",
    )
    expect(DRIVER_SRC).toContain("extra.patchBudget = buildPhasePatchBudget({")
  })

  test("runner driver blocks strict over-budget patches before official verify", () => {
    expect(DRIVER_SRC).toContain("const strictBudget =")
    expect(DRIVER_SRC).toContain("posture.patchBudgetStrict && instance.swebench !== undefined")
    expect(DRIVER_SRC).toContain("if (strictBudget !== undefined && !strictBudget.withinBudget)")
    expect(DRIVER_SRC).toContain("buildStrictPatchBudgetBlockedResult({")
    expect(DRIVER_SRC).toContain("verdict: strictBudget")
  })
})
