/**
 * Single-instance SWE-bench-style runner — top-level orchestration.
 *
 * Prepares an isolated sandbox copy of the instance repo (the corpus is NEVER
 * mutated), runs a real agent (runAgent + defaultTools) against the problem
 * statement, then runs the instance's testCmd (or the Python harness) to
 * decide pass/fail and captures a unified diff of the sandbox as the produced
 * patch.
 *
 * This file is the ONLY place that ties the eval sub-slice together:
 *   sandbox.create → env-prep.run → snapshot.withSnapshot(runAgent) →
 *   verdict.verify → report.emit*. Each step lives in its own sibling module
 *   (sandbox.ts / env-prep.ts / snapshot.ts / verdict.ts / report.ts / exec.ts).
 *
 * Behavior is byte-identical to the pre-decompose `src/apps/bench/runner.ts`;
 * this is a pure structural refactor.
 */

import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { BenchAttemptOutcome, InstanceResult } from "../types"
import { drainReproVoteOutcomes, summarizeReproVoteOutcomes } from "./repair/repro-vote"
import type { AttemptOutcome } from "./retry-policy"

export {
  buildSelectionCandidateFamilyBundle,
  cleanSelectionPromptEnabled,
  composeSelectionAgentHint,
  selectionGenerationEnvCaveats,
  withCandidateFamilyAuthorityContracts,
} from "./selection-assembly"

/**
 * A5 — drain the per-instance repro-vote outcome sink and attach the typed
 * telemetry to the result. Drained EXACTLY ONCE per instance (the drain is
 * consuming), so a later read can never double-count. Returns the result
 * unchanged when no vote round was recorded (knob off / no reproducing set) so
 * the report stays byte-identical. The sink is RESET at instance start (see
 * `runInstanceOnce`), guaranteeing no cross-instance accumulation.
 */
export const attachReproVoteOutcomes = (result: InstanceResult): InstanceResult => {
  const summary = summarizeReproVoteOutcomes(drainReproVoteOutcomes())
  return summary === undefined ? result : { ...result, reproVoteOutcomes: summary }
}

/** A1 follow-through: persist the drained repro-vote summary under the SAME
 *  per-instance artifact directory so full-remote RCA has the round/tally record
 *  even after the process exits. Best-effort + observe-only: write failures are
 *  swallowed and never perturb the result shape or grading path. */
export const attachAndPersistReproVoteOutcomes = async (
  result: InstanceResult,
): Promise<InstanceResult> => {
  const attached = attachReproVoteOutcomes(result)
  if (attached.reproVoteOutcomes === undefined || attached.reproArtifactPath === undefined) {
    return attached
  }
  try {
    await mkdir(attached.reproArtifactPath, { recursive: true })
    await writeFile(
      join(attached.reproArtifactPath, "vote-summary.json"),
      `${JSON.stringify(attached.reproVoteOutcomes, null, 2)}\n`,
    )
  } catch {
    // observe-only: a persistence failure must never disturb the result path.
  }
  return attached
}

/** A5 — reset the per-instance repro-vote sink at instance START. Re-exported so
 *  the apps/bench driver resets the SAME module sink (one SSOT) before its run,
 *  preventing cross-instance accumulation on either driver. */
export { resetReproVoteOutcomes } from "./repair/repro-vote"

/** Project `AttemptOutcome` (the retry-policy enum) into `BenchAttemptOutcome`
 *  (the wire shape on `InstanceResult.budget`). Same union, mirrored here so
 *  the bench-types module doesn't have to depend on `retry-policy.ts`.
 *  Exported so the apps/bench driver's retry wrapper stamps an identical shape. */
export const projectOutcome = (o: AttemptOutcome): BenchAttemptOutcome => {
  if (o.kind === "pass") return { kind: "pass" }
  if (o.kind === "empty-patch") {
    return o.reason !== undefined
      ? { kind: "empty-patch", reason: o.reason }
      : { kind: "empty-patch" }
  }
  if (o.kind === "admission-blocked") {
    return { kind: "admission-blocked", source: o.source, reason: o.reason }
  }
  if (o.kind === "generation-fail") return { kind: "generation-fail", reason: o.reason }
  if (o.kind === "grader-invalid") return { kind: "grader-invalid", reason: o.reason }
  if (o.kind === "timeout") return { kind: "timeout" }
  if (o.kind === "real-fail") return { kind: "real-fail", subkind: o.subkind }
  return { kind: "infra-fail", reason: o.reason }
}

// Re-export the observation usage tap so test fixtures and other internals can
// continue to use bench's typed surface unchanged.
export { BenchObserver, UsageTap } from "../observe"
// Adaptive (V5) phase evidence — extracted to `./driver/adaptive-evidence.ts`
// (pure code motion). `buildAdaptivePhasePacket` was public; re-export verbatim.
export { buildAdaptivePhasePacket } from "./driver/adaptive-evidence"
// Per-attempt context prep + main-phase dispatch — extracted to
// `./driver/attempt-context.ts` (pure code motion). These were public on driver;
// re-export verbatim.
export {
  maybeValidateTerminalResult,
  prepareAttemptContext,
} from "./driver/attempt-context"
// Candidate-family inference + selection port helpers — extracted to
// `./driver/candidate-family-ports.ts` (pure code motion). These were public on
// driver; re-export verbatim so importers are unaffected.
export {
  deriveCandidateStructuralRepair,
  makeSelectionRegressionPort,
  makeSelectionStaticSanityPort,
  withCandidateFamilyPublicContracts,
} from "./driver/candidate-family-ports"
// AgentConfig assembly — extracted to `./driver/config-build.ts` (pure code
// motion). These were public on driver; re-export verbatim so importers
// (apps/bench + tests) are unaffected.
export {
  benchBudgetMeterFromEnv,
  benchVerifyAuthorityCommandsOf,
  buildConfig,
  emitKnobsApplied,
  repairLocalizePhaseSuppressed,
} from "./driver/config-build"
// Shared run-instance vocabulary — extracted to `./driver/context-types.ts`
// (pure code motion). `RunInstanceDeps` + `PreparedAttemptContext` were public
// on driver; re-export them verbatim so importers are unaffected.
export type { PreparedAttemptContext, RunInstanceDeps } from "./driver/context-types"
// Bench env-var parsers + opt-in resolver — extracted to
// `./driver/env-knob-parse.ts` (pure code motion). Re-exported verbatim so the
// public driver surface (apps/bench + tests) is unchanged by the split.
export type { IssueHintMode } from "./driver/env-knob-parse"
export {
  benchOptIns,
  parseBenchBranchSearchK,
  parseLocalizePhaseEnv,
} from "./driver/env-knob-parse"
// Pre-agent localization + repair-escalation prep — extracted to
// `./driver/localize-prep.ts` (pure code motion). These were public on driver;
// re-export verbatim so importers are unaffected.
export type { PrepareIssueHintDeps } from "./driver/localize-prep"
export {
  adaptiveNextPassOwners,
  adaptiveRepairEscalationOwners,
  maybeRunRepairEscalationFollowup,
  parseLocalizeRankedLines,
  prepareIssueHint,
  repairEscalationFollowupOwners,
} from "./driver/localize-prep"
// External repair-rounds phase — extracted to `./driver/repair-phase.ts` (pure
// code motion). These were public on driver; re-export verbatim.
export {
  buildRepairBreadthRunCandidates,
  runRepairRoundsInSnapshot,
} from "./driver/repair-phase"
// Repo source enumeration + strict-preset LSP grounding — extracted to
// `./driver/repo-source-scan.ts` (pure code motion). Re-exported verbatim so
// the public driver surface (apps/bench + tests) is unchanged.
export { enumerateRepoSources, StrictLspGroundingDegradedError } from "./driver/repo-source-scan"
// Repro-test preparation slice — extracted to `./driver/repro-test-prep.ts`
// (pure code motion). Re-exported here verbatim so the public driver surface
// (apps/bench + tests) is unchanged by the split.
export type {
  PrepareReproTestDeps,
  PrepareReproTestDetailedResult,
} from "./driver/repro-test-prep"
export {
  composeWithReproHint,
  installReproTestHint,
  parseBenchReproTestK,
  prepareReproTest,
  prepareReproTestDetailed,
  prepareSelectionReproSources,
  REPRO_FILE_NAME,
  REPRO_HINT_MESSAGE,
  reproHintMessage,
  selectionReproPrepK,
  validatedReproContractSeed,
  validatedReproRepairSeed,
} from "./driver/repro-test-prep"
// Per-instance result assembly — extracted to `./driver/result-assembly.ts`
// (pure code motion). These were public on driver; re-export verbatim.
export {
  envPrepFailedResult,
  isSwebenchInfraGradeFailure,
  latePhaseFailureResultOf,
  swebenchGraderInvalidVerdict,
  terminalAgentResult,
  verifyAndFinalizeResult,
} from "./driver/result-assembly"
// Verify-select phase — extracted to `./driver/selection-phase.ts` (pure code
// motion). These were public on driver; re-export verbatim.
export type { SelectionReproPolicy } from "./driver/selection-phase"
export {
  cleanupSelectionCandidateSandbox,
  computeEffectiveProofRequired,
  familyCoverageCoeditEnabled,
  resolveLaneLlm,
  selectionReproPolicy,
} from "./driver/selection-phase"
// Selection / repair-round port factories — extracted to
// `./driver/selection-port-factories.ts` (pure code motion). Re-exported
// verbatim so the public driver surface (apps/bench + tests) is unchanged.
export {
  applySampleTemperature,
  buildReproVoteValidate,
  makeAcceptanceSelectCandidates,
  makeCalibratedReproConsensusPort,
  makeReproConsensusProofSelectionPort,
  makeReproConsensusSelectionPort,
  maybeReviewSubmission,
  persistReproVoteRoundArtifacts,
  reproExecBundle,
  resolveAcceptanceLlmRerank,
  resolveLocationFanoutSeeder,
} from "./driver/selection-port-factories"
export type { BenchIssueHintMode, BenchKnobState, BenchPosture } from "./knobs-bench"
// Knob wiring helpers — re-exported for the report path + tests so callers
// don't have to import from two siblings.
export {
  applyBenchKnobs,
  benchPostureFromState,
  knobsForReport,
  readKnobValue,
  resolveBenchKnobs,
} from "./knobs-bench"
export type { AttemptOutcome, RetryPolicy } from "./retry-policy"
/** Re-export the classifier + policy types so apps/bench callers can wire
 *  custom policies (test seam) or inspect outcomes without reaching into the
 *  retry-policy sub-slice directly. */
export {
  classifyOutcome,
  DEFAULT_POLICY,
  parseRetryTransientEnv,
  runRetryLoop,
} from "./retry-policy"
