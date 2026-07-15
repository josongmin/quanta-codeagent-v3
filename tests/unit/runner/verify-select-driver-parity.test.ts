import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")
// The runner core driver was split (jul-02 god-file reduction) into `./driver/*`
// submodules — PURE code motion. The verify-select / patch-budget / proof-port /
// owner-widening definitions the runner core OWNS now live across those submodules
// (`selection-phase.ts`, `localize-prep.ts`, `config-build.ts`, `repair-phase.ts`,
// …). Aggregate the barrel + every submodule source so these "runner core DEFINES
// X" parity assertions still resolve against the runner-core-owned code, unchanged
// in intent by the file split.
const DRIVER_DIR = join(REPO_ROOT, "src/runner/batch/eval/driver")
const DRIVER_SRC = [
  readFileSync(join(REPO_ROOT, "src/runner/batch/eval/driver.ts"), "utf8"),
  ...readdirSync(DRIVER_DIR)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => readFileSync(join(DRIVER_DIR, f), "utf8")),
].join("\n")
const APP_DRIVER_SRC = readFileSync(join(REPO_ROOT, "src/apps/bench/eval/driver.ts"), "utf8")

describe("runner verify-select and patch-budget driver parity", () => {
  test("the verify-select orchestrator still executes the knob instead of silently ignoring it", () => {
    // The per-instance verify-select ORCHESTRATOR is the app driver's
    // `runSelectionPhase` (the runner core's dead duplicate was deleted — the
    // runner core is now the shared-helper LIBRARY that the app consumes). The
    // gate + knob wiring must stay on the LIVE orchestration path.
    expect(APP_DRIVER_SRC).toContain("const runSelectionPhase = async")
    expect(APP_DRIVER_SRC).toMatch(
      /verifySelectN !== undefined && (?:args\.)?instance\.swebench !== undefined/,
    )
    expect(APP_DRIVER_SRC).toContain("posture.verifySelectConcurrency")
    expect(APP_DRIVER_SRC).toContain("posture.verifySelectEarlyAccept")
    expect(APP_DRIVER_SRC).toContain("posture.verifySelectRegression")
    expect(APP_DRIVER_SRC).toContain("posture.verifySelectLlmRiskGate")
    expect(APP_DRIVER_SRC).toContain("posture.verifySelectRepro")
    expect(APP_DRIVER_SRC).toContain("selectionGenerationErrorOf({")
    // The runner core still DEFINES the verify-select shared library the app
    // orchestrator consumes (single SSOT — the app must not re-implement these).
    expect(DRIVER_SRC).toContain("export const computeEffectiveProofRequired")
    expect(DRIVER_SRC).toContain("export const selectionReproPolicy")
  })

  test("both drivers keep terminal and late-failure phase stopReason wiring", () => {
    expect(DRIVER_SRC).toContain('phase.stopReason === "max_turns" && phase.patch.trim() === ""')
    expect(APP_DRIVER_SRC).toContain("maybeValidateTerminalResult({")
    expect(DRIVER_SRC).toContain("latePhaseFailureResultOf({")
    expect(APP_DRIVER_SRC).toContain("latePhaseFailureResultOf({")
    expect(DRIVER_SRC).toContain('verdict: "degraded"')
    expect(APP_DRIVER_SRC).toContain('verdict: "degraded"')
    expect(APP_DRIVER_SRC).toContain(
      "attachAndPersistReproVoteOutcomes(\n      runInstanceFailureResult(instance, sandbox, state, error)",
    )
  })

  test("owner-widening follow-up is wired through the shared helpers", () => {
    // Post ac3a266f8 the runner driver's own per-instance orchestrator was
    // deleted as dead — it is now the shared-helper LIBRARY (DEFINES the helpers,
    // exported), and the app driver is the sole orchestrator that CALLS them.
    // Parity = runner DEFINES, app CONSUMES (with the owner-widening telemetry).
    expect(DRIVER_SRC).toContain("export const adaptiveNextPassOwners")
    expect(DRIVER_SRC).toContain("export const maybeRunRepairEscalationFollowup")
    expect(APP_DRIVER_SRC).toContain("const widening = await adaptiveNextPassOwners({")
    expect(APP_DRIVER_SRC).toContain("const followup = await maybeRunRepairEscalationFollowup({")
    expect(APP_DRIVER_SRC).toContain("args.state.phase.ownerWidening = followup.telemetry")
  })

  test("the orchestrator routes selection evidence + prompt seed assembly through the shared helper", () => {
    // Evidence/prompt assembly is a SHARED helper the runner core re-exports and
    // the app orchestrator consumes — the app must not re-inline the seed/merge
    // builders. (The runner core's dead duplicate orchestrator was deleted, so
    // the CALL sites now live only on the LIVE app path.)
    expect(DRIVER_SRC).toContain('from "./selection-assembly"')
    expect(APP_DRIVER_SRC).toContain('from "@/runner/batch/eval/selection-assembly"')
    expect(APP_DRIVER_SRC).toContain("prepareSelectionEvidenceContext({")
    expect(APP_DRIVER_SRC).toContain("composeSelectionAgentHint(")
    expect(APP_DRIVER_SRC).not.toContain("const buildSelectionMergeHint =")
    expect(APP_DRIVER_SRC).not.toContain("const selectionGenerationPromptInput =")
  })

  test("verify-select owner seeds still come from ClosureBundle evidence on the orchestration path", () => {
    // The seed-selection wiring lives on the LIVE orchestrator (app driver); the
    // runner core's deleted duplicate no longer carries it.
    const expected =
      /(?:args\.prepared\.)?closureSession\?\.bundle\.evidence\.candidates\.map\(\(c\) => c\.file\)\s+\?\?\s+(?:args\.prepared\.)?localizeCandidates/
    expect(APP_DRIVER_SRC).toMatch(expected)
  })

  test("the orchestrator keeps selector authority contracts separate from advisory prompt contracts", () => {
    // Contract wiring lives on the LIVE orchestrator (app driver) after the
    // runner core's dead duplicate was deleted.
    expect(APP_DRIVER_SRC).toContain("selectionAuthorityContracts")
    expect(APP_DRIVER_SRC).toContain("advisoryPromptContracts")
    expect(APP_DRIVER_SRC).toContain("publicContracts: args.selectionAuthorityContracts")
    expect(APP_DRIVER_SRC).toContain("promptContracts: advisoryPromptContracts")
  })

  test("the orchestrator keeps verificationTarget and proof-port wiring on the clean path", () => {
    // The runner core still DEFINES the proof-required decision (shared library);
    // the app orchestrator CALLS it + wires the proof ports.
    expect(DRIVER_SRC).toContain("export const computeEffectiveProofRequired")
    expect(APP_DRIVER_SRC).toContain("computeEffectiveProofRequired(")
    expect(APP_DRIVER_SRC).toContain("verificationTargetFromPlan(verificationPlan)")
    expect(APP_DRIVER_SRC).toContain("mweProofSelectionPort")
    expect(APP_DRIVER_SRC).toContain("publicRegressionProofSelectionPort")
    expect(APP_DRIVER_SRC).toContain("reproConsensusProofSelectionPort")
    expect(APP_DRIVER_SRC).toContain("proofCalibration")
    expect(APP_DRIVER_SRC).toContain("mweProof: args.mweProofSelectionPort")
    expect(APP_DRIVER_SRC).toContain("reproConsensusProof: args.reproConsensusProofSelectionPort")
  })

  test("both drivers keep deterministic family-coverage coedit default-OFF behind the shared helper", () => {
    expect(DRIVER_SRC).toContain("familyCoverageCoeditEnabled(process.env)")
    expect(APP_DRIVER_SRC).toContain("familyCoverageCoeditEnabled(process.env)")
    expect(DRIVER_SRC).toContain("QUANTA_BENCH_FAMILY_COVERAGE_COEDIT")
    expect(APP_DRIVER_SRC).toContain("repairFamilyCoverage")
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
