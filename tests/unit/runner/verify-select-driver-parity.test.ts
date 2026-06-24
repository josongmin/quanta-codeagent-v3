import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")
const DRIVER_SRC = readFileSync(join(REPO_ROOT, "src/runner/batch/eval/driver.ts"), "utf8")
const APP_DRIVER_SRC = readFileSync(join(REPO_ROOT, "src/apps/bench/eval/driver.ts"), "utf8")

describe("runner verify-select and patch-budget driver parity", () => {
  test("runner driver still executes verify-select instead of silently ignoring the knob", () => {
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
    expect(DRIVER_SRC).toContain("selectionPhaseResultOf({")
    expect(DRIVER_SRC).toContain("selectionGenerationErrorOf({")
    expect(APP_DRIVER_SRC).toContain("selectionGenerationErrorOf({")
  })

  test("both drivers keep terminal and late-failure phase stopReason wiring", () => {
    expect(DRIVER_SRC).toContain('phase.stopReason === "max_turns" && phase.patch.trim() === ""')
    expect(APP_DRIVER_SRC).toContain("maybeValidateTerminalResult({")
    expect(DRIVER_SRC).toContain("latePhaseFailureResultOf({")
    expect(APP_DRIVER_SRC).toContain("latePhaseFailureResultOf({")
    expect(DRIVER_SRC).toContain('verdict: "degraded"')
    expect(APP_DRIVER_SRC).toContain('verdict: "degraded"')
    expect(APP_DRIVER_SRC).toContain(
      "attachReproVoteOutcomes(runInstanceFailureResult(instance, sandbox, state, error))",
    )
  })

  test("both drivers wire owner-widening follow-up through the shared helpers", () => {
    expect(DRIVER_SRC).toContain("const widening = await adaptiveNextPassOwners({")
    expect(APP_DRIVER_SRC).toContain("const widening = await adaptiveNextPassOwners({")
    expect(DRIVER_SRC).toContain("const followup = await maybeRunRepairEscalationFollowup({")
    expect(APP_DRIVER_SRC).toContain("const followup = await maybeRunRepairEscalationFollowup({")
    expect(DRIVER_SRC).toContain("phase.ownerWidening = followup.telemetry")
    expect(APP_DRIVER_SRC).toContain("args.state.phase.ownerWidening = followup.telemetry")
  })

  test("both drivers route selection evidence and prompt seed assembly through the shared helper", () => {
    expect(DRIVER_SRC).toContain('from "./selection-assembly"')
    expect(APP_DRIVER_SRC).toContain('from "@/runner/batch/eval/selection-assembly"')
    expect(DRIVER_SRC).toContain("prepareSelectionEvidenceContext({")
    expect(APP_DRIVER_SRC).toContain("prepareSelectionEvidenceContext({")
    expect(DRIVER_SRC).toContain("composeSelectionAgentHint(")
    expect(APP_DRIVER_SRC).toContain("composeSelectionAgentHint(")
    expect(DRIVER_SRC).not.toContain("const selectionCandidateSeed =")
    expect(DRIVER_SRC).not.toContain("const selectionMergeHint =")
    expect(APP_DRIVER_SRC).not.toContain("const buildSelectionMergeHint =")
    expect(APP_DRIVER_SRC).not.toContain("const selectionGenerationPromptInput =")
  })

  test("verify-select owner seeds still come from ClosureBundle evidence in both drivers", () => {
    const expected =
      /(?:args\.prepared\.)?closureSession\?\.bundle\.evidence\.candidates\.map\(\(c\) => c\.file\)\s+\?\?\s+(?:args\.prepared\.)?localizeCandidates/
    expect(DRIVER_SRC).toMatch(expected)
    expect(APP_DRIVER_SRC).toMatch(expected)
  })

  test("both drivers keep selector authority contracts separate from advisory prompt contracts", () => {
    expect(DRIVER_SRC).toContain("selectionAuthorityContracts")
    expect(DRIVER_SRC).toContain("advisoryPromptContracts")
    expect(APP_DRIVER_SRC).toContain("selectionAuthorityContracts")
    expect(APP_DRIVER_SRC).toContain("advisoryPromptContracts")
    expect(DRIVER_SRC).toContain("publicContracts: selectionAuthorityContracts")
    expect(APP_DRIVER_SRC).toContain("publicContracts: args.selectionAuthorityContracts")
    expect(DRIVER_SRC).toContain("promptContracts: advisoryPromptContracts")
    expect(APP_DRIVER_SRC).toContain("promptContracts: advisoryPromptContracts")
  })

  test("both drivers keep verificationTarget and proof-port wiring on the clean path", () => {
    expect(APP_DRIVER_SRC).toContain("verificationTargetFromPlan(verificationPlan)")
    expect(DRIVER_SRC).toContain("verificationTarget: args.verificationTarget")
    expect(APP_DRIVER_SRC).toContain("mweProofSelectionPort")
    expect(APP_DRIVER_SRC).toContain("publicRegressionProofSelectionPort")
    expect(APP_DRIVER_SRC).toContain("reproConsensusProofSelectionPort")
    expect(DRIVER_SRC).toContain("ports.mweProof = args.mweProofSelectionPort")
    expect(DRIVER_SRC).toContain(
      "ports.publicRegressionProof = args.publicRegressionProofSelectionPort",
    )
    expect(DRIVER_SRC).toContain(
      "ports.reproConsensusProof = args.reproConsensusProofSelectionPort",
    )
  })

  test("runner driver emits patch-budget telemetry when the knob is on", () => {
    expect(DRIVER_SRC).toContain("buildPhasePatchBudget")
    expect(DRIVER_SRC).toMatch(
      /if \(\((?:args\.)?posture\.patchBudget \|\| (?:args\.)?posture\.patchBudgetStrict\) && (?:args\.)?instance\.swebench !== undefined\)/,
    )
    expect(DRIVER_SRC).toContain("extra.patchBudget = buildPhasePatchBudget({")
  })

  test("strict patch-budget stays telemetry-only; neither driver keeps terminal-discard residue", () => {
    expect(DRIVER_SRC).not.toContain("maybeStrictBudgetBlockedResult({")
    expect(DRIVER_SRC).not.toContain("const strictBudgetBlocked =")
    expect(APP_DRIVER_SRC).not.toContain("maybeStrictBudgetBlockedResult({")
    expect(APP_DRIVER_SRC).not.toContain("const strictBudgetBlocked =")
  })
})
