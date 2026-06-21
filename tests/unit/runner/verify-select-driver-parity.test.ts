import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")
const DRIVER_SRC = readFileSync(join(REPO_ROOT, "src/runner/batch/eval/driver.ts"), "utf8")
const APP_DRIVER_SRC = readFileSync(join(REPO_ROOT, "src/apps/bench/eval/driver.ts"), "utf8")

const declaredExpectedWireCount = (src: string): number =>
  [...src.matchAll(/declaredExpected:\s*makeDeclaredExpectedSelectionPort\(instance\)/g)].length

describe("runner verify-select and patch-budget driver parity", () => {
  test("runner driver executes verify-select instead of silently ignoring the knob", () => {
    expect(DRIVER_SRC).toContain("const runSelectionPhase = async")
    expect(DRIVER_SRC).toMatch(
      /verifySelectN !== undefined && (?:args\.)?instance\.swebench !== undefined/,
    )
    expect(DRIVER_SRC).toContain("posture.verifySelectConcurrency")
    expect(DRIVER_SRC).toContain("posture.verifySelectEarlyAccept")
    expect(DRIVER_SRC).toContain("posture.verifySelectRegression")
    expect(DRIVER_SRC).toContain("posture.verifySelectLlmRiskGate")
    expect(DRIVER_SRC).toContain("posture.verifySelectRepro")
    expect(APP_DRIVER_SRC).toContain("posture.verifySelectLlmRiskGate")
    expect(DRIVER_SRC).toContain("reproOracleCalibration: calibration")
    expect(DRIVER_SRC).toContain("selectionTelemetry: summarizeSelection(result)")
    expect(DRIVER_SRC).toContain("result.terminalCandidate?.stopReason")
    expect(APP_DRIVER_SRC).toContain("result.terminalCandidate?.stopReason")
    expect(DRIVER_SRC).toContain("selectionGenerationErrorOf({")
    expect(APP_DRIVER_SRC).toContain("selectionGenerationErrorOf({")
    expect(DRIVER_SRC).toContain("candidatePatchAppliesCleanly")
    expect(DRIVER_SRC).toContain("applyClean: (c) =>")
    expect(DRIVER_SRC).toContain("prepareMweProofSelectionPort")
    expect(APP_DRIVER_SRC).toContain("prepareMweProofSelectionPort")
    expect(DRIVER_SRC).toContain('selectorMode === "clean"')
    expect(APP_DRIVER_SRC).toContain('selectorMode === "clean"')
    expect(DRIVER_SRC).toContain("mweProof: mweProofSelectionPort")
    expect(APP_DRIVER_SRC).toContain("mweProof: mweProofSelectionPort")
    expect(DRIVER_SRC).toContain(
      "rcaTargetGates ? { declaredExpected: makeDeclaredExpectedSelectionPort(instance) } : {}",
    )
    expect(APP_DRIVER_SRC).toContain(
      "rcaTargetGates ? { declaredExpected: makeDeclaredExpectedSelectionPort(instance) } : {}",
    )
    expect(declaredExpectedWireCount(DRIVER_SRC)).toBe(1)
    expect(declaredExpectedWireCount(APP_DRIVER_SRC)).toBe(1)
  })

  test("both drivers preserve empty max-turns authority on the terminal path", () => {
    expect(DRIVER_SRC).toContain('phase.stopReason === "max_turns" && phase.patch.trim() === ""')
    expect(APP_DRIVER_SRC).toContain("maybeValidateTerminalResult({")
  })

  test("both drivers preserve phase stopReason through late catch paths", () => {
    expect(DRIVER_SRC).toContain("latePhaseFailureResultOf({")
    expect(DRIVER_SRC).toContain('verdict: "degraded"')
    expect(DRIVER_SRC).toContain("...(prepared !== undefined ? { prepared, sandbox } : {})")
    expect(APP_DRIVER_SRC).toContain("latePhaseFailureResultOf({")
    expect(APP_DRIVER_SRC).toContain('verdict: "degraded"')
    expect(APP_DRIVER_SRC).toContain("...(prepared !== undefined ? { prepared, sandbox } : {})")
  })

  test("shared late-failure helper preserves prepared-derived diagnostics in the owner", () => {
    expect(DRIVER_SRC).toContain("const attachLateFailureArtifacts =")
    expect(DRIVER_SRC).toContain(
      "attachClosureMetrics({ extra: args.extra, phase: args.phase, prepared: args.prepared })",
    )
    expect(DRIVER_SRC).toContain("attachSelectionAndClosureArtifacts({")
    expect(DRIVER_SRC).toContain("selectionTelemetry: args.phase.selectionTelemetry")
    expect(DRIVER_SRC).toContain("reproOracleCalibration: args.phase.reproOracleCalibration")
  })

  test("verify-select owner seeds come from ClosureBundle evidence in both drivers", () => {
    const expected =
      /(?:args\.prepared\.)?closureSession\?\.bundle\.evidence\.candidates\.map\(\(c\) => c\.file\)\s+\?\?\s+(?:args\.prepared\.)?localizeCandidates/
    expect(DRIVER_SRC).toMatch(expected)
    expect(APP_DRIVER_SRC).toMatch(expected)
  })

  test("runner driver emits patch-budget telemetry when the knob is on", () => {
    expect(DRIVER_SRC).toContain("buildPhasePatchBudget")
    expect(DRIVER_SRC).toMatch(
      /if \(\((?:args\.)?posture\.patchBudget \|\| (?:args\.)?posture\.patchBudgetStrict\) && (?:args\.)?instance\.swebench !== undefined\)/,
    )
    expect(DRIVER_SRC).toContain("extra.patchBudget = buildPhasePatchBudget({")
  })

  test("strict patch-budget stays telemetry-only; neither driver keeps terminal-discard residue", () => {
    expect(DRIVER_SRC).toMatch(
      /if \(\((?:args\.)?posture\.patchBudget \|\| (?:args\.)?posture\.patchBudgetStrict\) && (?:args\.)?instance\.swebench !== undefined\)/,
    )
    expect(DRIVER_SRC).not.toContain("maybeStrictBudgetBlockedResult({")
    expect(DRIVER_SRC).not.toContain("const strictBudgetBlocked =")
    expect(APP_DRIVER_SRC).not.toContain("maybeStrictBudgetBlockedResult({")
    expect(APP_DRIVER_SRC).not.toContain("const strictBudgetBlocked =")
  })
})
