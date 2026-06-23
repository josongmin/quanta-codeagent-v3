import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")
const DRIVER_SRC = readFileSync(join(REPO_ROOT, "src/runner/batch/eval/driver.ts"), "utf8")
const APP_DRIVER_SRC = readFileSync(join(REPO_ROOT, "src/apps/bench/eval/driver.ts"), "utf8")

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
    expect(DRIVER_SRC).toContain("selectionGenerationFailurePhase({")
    expect(DRIVER_SRC).toContain("selectionPhaseResultOf({")
    // jun-23: calibration is threaded via the `reportCalibration` selector
    // (prefers proofCalibration when available, else falls back to
    // selectionState.calibration) — still wired into both phase builders.
    expect(DRIVER_SRC).toContain("calibration: reportCalibration")
    expect(DRIVER_SRC).toContain("? selectionState.proofCalibration")
    expect(DRIVER_SRC).toContain(": selectionState.calibration")
    expect(DRIVER_SRC).toContain("selectionTelemetry: summarizeSelection(args.result)")
    expect(DRIVER_SRC).toContain("result.terminalCandidate?.stopReason")
    expect(APP_DRIVER_SRC).toContain("result.terminalCandidate?.stopReason")
    expect(DRIVER_SRC).toContain("selectionGenerationErrorOf({")
    expect(APP_DRIVER_SRC).toContain("selectionGenerationErrorOf({")
    expect(DRIVER_SRC).toContain("candidatePatchAppliesCleanly")
    expect(DRIVER_SRC).toContain("applyClean: (candidate) =>")
    expect(APP_DRIVER_SRC).toContain("applyClean: (c) =>")
    expect(DRIVER_SRC).toContain("prepareMweProofSelectionPort")
    expect(APP_DRIVER_SRC).toContain("prepareMweProofSelectionPort")
    expect(DRIVER_SRC).toContain("makeDiscoveredRepoRegressionProofPort")
    expect(APP_DRIVER_SRC).toContain("makeDiscoveredRepoRegressionProofPort")
    expect(DRIVER_SRC).toContain("makeReproConsensusProofSelectionPort")
    expect(APP_DRIVER_SRC).toContain("makeReproConsensusProofSelectionPort")
    expect(DRIVER_SRC).toContain("deriveCandidateStructuralRepair")
    expect(APP_DRIVER_SRC).toContain("deriveCandidateStructuralRepair")
    expect(DRIVER_SRC).toContain('selectorMode === "clean"')
    expect(APP_DRIVER_SRC).toContain('selectorMode === "clean"')
    expect(DRIVER_SRC).toContain("ports.mweProof = args.mweProofSelectionPort")
    expect(DRIVER_SRC).toContain(
      "ports.publicRegressionProof = args.publicRegressionProofSelectionPort",
    )
    expect(DRIVER_SRC).toContain(
      "ports.reproConsensusProof = args.reproConsensusProofSelectionPort",
    )
    expect(APP_DRIVER_SRC).toContain("mweProof: mweProofSelectionPort")
    expect(APP_DRIVER_SRC).toContain("publicRegressionProof: publicRegressionProofSelectionPort")
    expect(APP_DRIVER_SRC).toContain("reproConsensusProof: reproConsensusProofSelectionPort")
    // jun-22: the answer-key `declaredExpected` gold-patch matcher was removed from
    // both drivers (selection-declared-expected.ts deleted). Parity = absent in both.
    expect(DRIVER_SRC).not.toContain("makeDeclaredExpectedSelectionPort")
    expect(APP_DRIVER_SRC).not.toContain("makeDeclaredExpectedSelectionPort")
  })

  test("both drivers preserve empty max-turns authority on the terminal path", () => {
    expect(DRIVER_SRC).toContain('phase.stopReason === "max_turns" && phase.patch.trim() === ""')
    expect(APP_DRIVER_SRC).toContain("maybeValidateTerminalResult({")
  })

  test("both drivers preserve phase stopReason through late catch paths", () => {
    expect(DRIVER_SRC).toContain("latePhaseFailureResultOf({")
    expect(DRIVER_SRC).toContain('verdict: "degraded"')
    expect(DRIVER_SRC).toContain(
      "...(args.prepared !== undefined ? { prepared: args.prepared, sandbox: args.sandbox } : {})",
    )
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

  test("proof-clean generation and repair thread the same verificationTarget through both drivers", () => {
    expect(APP_DRIVER_SRC).toContain("args.prepared.verificationPlan,")
    expect(APP_DRIVER_SRC).toContain("args.prepared.reproTest,")
    expect(APP_DRIVER_SRC).toMatch(
      /\.\.\.\(verificationTarget !== undefined \? \{ verificationTarget \} : \{\}\)/,
    )
    expect(DRIVER_SRC).toContain("args.prepared.verificationPlan,")
    expect(DRIVER_SRC).toContain("args.prepared.reproTest,")
    expect(DRIVER_SRC).toMatch(
      /\.\.\.\(verificationTarget !== undefined \? \{ verificationTarget \} : \{\}\)/,
    )
    expect(DRIVER_SRC).toMatch(/verificationTarget:\s*args\.verificationTarget/)
    expect(DRIVER_SRC).toMatch(
      /\.\.\.\(args\.verificationTarget !== undefined\s*\?\s*\{\s*verificationTarget:\s*args\.verificationTarget\s*\}\s*:\s*\{\}\)/,
    )
  })

  test("proof-clean generation in both drivers uses shared structural owner evidence packetization", () => {
    expect(DRIVER_SRC).toContain("buildSelectionOwnerEvidence({")
    expect(APP_DRIVER_SRC).toContain("buildSelectionOwnerEvidence({")
    expect(DRIVER_SRC).toContain("const selectionOwnerEvidence = buildSelectionOwnerEvidence({")
    expect(APP_DRIVER_SRC).toContain("const selectionOwnerEvidence = buildSelectionOwnerEvidence({")
    expect(DRIVER_SRC).toContain("buildSelectionGenerationPrompt({")
    expect(APP_DRIVER_SRC).toContain("buildSelectionGenerationPrompt({")
    expect(DRIVER_SRC).toContain("ownerEvidence: args.selectionOwnerEvidence")
    expect(DRIVER_SRC).toContain("selectionGenerationEnvCaveats({")
    expect(APP_DRIVER_SRC).toContain("ownerEvidence: selectionOwnerEvidence")
    expect(APP_DRIVER_SRC).toContain("baseValidatedRed: selectionBaseValidatedRed")
    expect(APP_DRIVER_SRC).toContain("selectionGenerationEnvCaveats({")
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
