/**
 * External REPAIR-ROUNDS phase orchestration (pure code motion from `driver.ts`,
 * byte-identical). Owns the repair-loop BREADTH candidate factory
 * (`buildRepairBreadthRunCandidates`), the in-snapshot repair-rounds runner
 * (`runRepairRoundsInSnapshot`), and `runRepairPhase` — ONE `withGitSnapshot`
 * wraps ALL rounds (continue-from-patched-tree), the official `verify()` runs
 * ONCE outside on the cumulative patch (no-leak). Depends on the extracted
 * agent-phase / selection / port-factory modules + `./context-types`.
 */

import { extractIssueHint } from "@/agent"
import { evaluateSuccessPredicate, type PrimaryRailStep } from "@/agent/closure"
import type { IssueDeclaredExpected } from "@/agent/verification-plan"
import type { Instance } from "../../types"
import type { RerankTier } from "../acceptance-rerank"
import { attributeAcceptanceTier } from "../acceptance-select"
import type { ChaRepairTarget } from "../cha-multisite"
import { resolveRepairEvaluatePredicate } from "../declared-expected-matcher"
import { exec } from "../exec"
import { coeditFamilyCoverageCandidate } from "../family-coverage-coedit"
import {
  type BenchKnobState,
  type BenchPosture,
  benchPostureFromState,
  resolveBenchKnobs,
} from "../knobs-bench"
import {
  type LlmEvidenceArtifacts,
  recordLlmEvidencePacket,
  type VerificationTargetFact,
} from "../llm-evidence-packet"
import type { PerCandidateSeed } from "../location-set-fanout"
import { applyCandidatePatch, materializeBuildEnv, resetToBase } from "../rematerialize"
import { writeCandidatePool } from "../repair/candidate-ledger-sink"
import { runRepairRounds } from "../repair/index"
import { buildRepairRoundSeedMessage } from "../repair/llm-evidence"
import { validate as defaultValidate } from "../repair/validator"
import { buildRepairRoundsConfig, makeRepairBreadthRunCandidates } from "../repair-breadth"
import { emitSandbox, type Wiring } from "../report"
import { cleanupSandbox, forkSandbox } from "../sandbox"
import type { Candidate } from "../selection-executor"
import { withGitSnapshot } from "../snapshot"
import { runAgentOnce } from "./agent-phase"
import { maybeReviewReproViability } from "../repro-viability-wire"
import { deriveCandidateStructuralRepair } from "./candidate-family-ports"
import { repairLocalizePhaseSuppressed } from "./config-build"
import { type Phase, type RunInstanceDeps, readSandboxSource } from "./context-types"
import { familyCoverageCoeditEnabled, resolveLaneLlm } from "./selection-phase"
import {
  applySampleTemperature,
  buildReproVoteValidate,
  makeAcceptanceSelectCandidates,
  maybeReviewSubmission,
  resolveAcceptanceLlmRerank,
} from "./selection-port-factories"

/**
 * Repair-path phase: ONE `withGitSnapshot` wraps ALL rounds (so the prior
 * round's edits persist into round N+1 — no `git reset/clean` between rounds).
 * The official `verify()` is NEVER invoked here — it runs ONCE outside, on the
 * cumulative final patch (no-leak invariant). The validator/buildContext are
 * injectable; production defaults are G1's `validate`/`buildRepairContext`.
 */
/** Shared repair-loop BREADTH candidate factory (jun-28). Both bench drivers
 *  (this runner core + `apps/bench/eval/driver.ts`) build the SAME B>1 fan-out
 *  here; the ONLY per-driver divergence — how a forked round runs the agent
 *  (the runner threads `chaMultisiteSteer`, the app does not) — is injected as
 *  `runAgentOnFork`. B≤1 ⇒ undefined ⇒ the orchestrator takes the legacy single
 *  path (byte-identical). Derives its types from `makeRepairBreadthRunCandidates`
 *  so the seam can never silently drift from the breadth contract. */
type RepairBreadthDeps = Parameters<typeof makeRepairBreadthRunCandidates>[0]
export const buildRepairBreadthRunCandidates = (args: {
  instance: Instance
  deps: RunInstanceDeps
  sandbox: string
  signal: AbortSignal
  repairPosture: BenchPosture
  repairBreadth: number
  validate: RepairBreadthDeps["validate"]
  repairEvaluatePredicate: RepairBreadthDeps["validateInputs"]["evaluatePredicate"]
  primaryRailStep: PrimaryRailStep | undefined
  chaRepairTargets: readonly ChaRepairTarget[] | undefined
  perCandidateSeed: PerCandidateSeed | undefined
  runAgentOnFork: RepairBreadthDeps["runAgentOnFork"]
}): ReturnType<typeof makeRepairBreadthRunCandidates> | undefined => {
  if (args.repairBreadth <= 1) return undefined
  return makeRepairBreadthRunCandidates({
    instanceId: args.instance.id,
    mainSandbox: args.sandbox,
    baseCommit: args.instance.swebench?.baseCommit,
    repo: args.instance.swebench?.repo,
    timeoutMs: args.deps.timeoutMs,
    resolveLaneLlm: (index) =>
      applySampleTemperature(
        resolveLaneLlm(args.deps, args.repairPosture.modelLaneDiversity, index),
        index,
      ),
    runAgentOnFork: args.runAgentOnFork,
    validate: args.validate,
    validateInputs: {
      exec,
      timeoutMs: args.deps.timeoutMs,
      readFile: async (path: string): Promise<string> => Bun.file(path).text(),
      evaluatePredicate: args.repairEvaluatePredicate,
      ...(args.primaryRailStep !== undefined ? { primaryRailStep: args.primaryRailStep } : {}),
    },
    sandboxPorts: { forkSandbox, cleanupSandbox },
    gitPorts: { resetToBase, applyCandidatePatch, materializeBuildEnv },
    // jun-29 OBSERVE-ONLY pool capture: when a run artifact root exists, persist
    // the FULL candidate pool per round (decision impact 0). Absent ⇒ no sink ⇒
    // byte-identical.
    ...(args.deps.reproArtifactRootPath !== undefined
      ? {
          recordCandidates: (round, candidates) =>
            writeCandidatePool(
              args.deps.reproArtifactRootPath as string,
              args.instance.id,
              round,
              candidates,
            ),
        }
      : {}),
    ...(args.repairPosture.selectorMode === "clean"
      ? {
          deriveCandidateStructuralRepair: (candidate: Candidate, candidateSandbox: string) =>
            deriveCandidateStructuralRepair({
              instance: args.instance,
              candidate,
              sandbox: candidateSandbox,
              signal: args.signal,
              ...(args.chaRepairTargets !== undefined
                ? { preferredTargets: args.chaRepairTargets }
                : {}),
            }),
        }
      : {}),
    ...(args.repairPosture.selectorMode === "clean" && familyCoverageCoeditEnabled(process.env)
      ? {
          repairFamilyCoverage: ({ sandbox: candidateSandbox, candidate, family, missingFiles }) =>
            coeditFamilyCoverageCandidate({
              sandbox: candidateSandbox,
              candidate,
              family,
              missingFiles,
              timeoutMs: args.deps.timeoutMs,
              baseCommit: args.instance.swebench?.baseCommit,
              repo: args.instance.swebench?.repo,
              ...(args.chaRepairTargets !== undefined
                ? { preferredTargets: args.chaRepairTargets }
                : {}),
            }),
        }
      : {}),
    // #7 location-set fanout: per-candidate lead-file seed (OFF ⇒ undefined ⇒
    // shared base seed ⇒ byte-identical).
    ...(args.perCandidateSeed !== undefined ? { perCandidateSeed: args.perCandidateSeed } : {}),
  })
}

/** Shared repair-round orchestration inside a git snapshot (jun-28). Both bench
 *  drivers run the SAME `runRepairRounds` here — owner-evidence seed assembly,
 *  acceptance/breadth wiring, repro-rail readFile. The ONLY per-driver divergence
 *  (the runner threads `chaMultisiteSteer` into the per-round agent, the app does
 *  not) is injected as `runOnce`. Returns the snapshot's final diff plus the raw
 *  rounds result so the caller derives the Phase verdict (no closure mutation). */
export const runRepairRoundsInSnapshot = async (args: {
  instance: Instance
  deps: RunInstanceDeps
  sandbox: string
  w: Wiring
  repair: NonNullable<RunInstanceDeps["repair"]>
  repairPosture: BenchPosture
  repairBreadth: number
  validate: RepairBreadthDeps["validate"]
  repairEvaluatePredicate: RepairBreadthDeps["validateInputs"]["evaluatePredicate"]
  primaryRailStep: PrimaryRailStep | undefined
  runCandidates: ReturnType<typeof makeRepairBreadthRunCandidates> | undefined
  acceptanceSelectCandidates: ReturnType<typeof makeAcceptanceSelectCandidates>
  siblingOwners: readonly string[]
  repairIssueSymbols: ReturnType<typeof extractIssueHint>["symbols"]
  verificationTarget: VerificationTargetFact | undefined
  repairLlmEvidence: Partial<LlmEvidenceArtifacts>
  runOnce: Parameters<typeof runRepairRounds>[0]["runOnce"]
}): Promise<{ patch: string; out: Awaited<ReturnType<typeof runRepairRounds>> }> => {
  let captured: Awaited<ReturnType<typeof runRepairRounds>> | undefined
  const patch = await withGitSnapshot(
    args.sandbox,
    args.deps.timeoutMs,
    args.instance.swebench?.baseCommit,
    async () => {
      await emitSandbox(
        args.w.observer,
        args.sandbox,
        args.instance.swebench?.baseCommit,
        args.deps.timeoutMs,
      )
      captured = await runRepairRounds({
        config: buildRepairRoundsConfig(
          args.repair.maxRounds,
          args.repairBreadth,
          args.repairPosture.repairStrongOracle,
        ),
        problem: args.instance.problemStatement,
        runOnce: args.runOnce,
        validate: args.validate,
        buildContext: (ctxArgs) => {
          const repairArgs = {
            ...ctxArgs,
            siblingOwners: args.siblingOwners,
            issueSymbols: args.repairIssueSymbols,
            readSource: (rel: string) => readSandboxSource(args.sandbox, rel),
            ...(args.verificationTarget !== undefined
              ? { verificationTarget: args.verificationTarget }
              : {}),
          }
          const repairSeed = buildRepairRoundSeedMessage(
            repairArgs,
            args.repair.buildContext?.(repairArgs),
          )
          recordLlmEvidencePacket(args.repairLlmEvidence, repairSeed.packet)
          return repairSeed.seedMsg
        },
        sandbox: args.sandbox,
        exec,
        readFile: async (path: string): Promise<string> => Bun.file(path).text(),
        timeoutMs: args.deps.timeoutMs,
        evaluatePredicate: args.repairEvaluatePredicate,
        ...(args.primaryRailStep !== undefined ? { primaryRailStep: args.primaryRailStep } : {}),
        // jun-28 BREADTH: present only when B>1 (else undefined ⇒ legacy single path).
        ...(args.runCandidates !== undefined ? { runCandidates: args.runCandidates } : {}),
        // jun-28 SOTA++ acceptance: present only when opt-in is on + a repro set exists.
        ...(args.acceptanceSelectCandidates !== undefined
          ? { selectCandidates: args.acceptanceSelectCandidates }
          : {}),
      })
    },
    args.instance.swebench?.repo,
  )
  // withGitSnapshot always invokes the callback, so `captured` is set; guard
  // defensively so a future refactor that changes that contract fails loudly.
  if (captured === undefined) throw new Error("runRepairRounds did not execute in snapshot")
  return { patch, out: captured }
}

interface RepairPhaseInputs {
  readonly repairPosture: BenchPosture
  readonly repairBreadth: number
  readonly repairIssueSymbols: ReturnType<typeof extractIssueHint>["symbols"]
  readonly repairLlmEvidence: Partial<LlmEvidenceArtifacts>
  readonly validate: RepairBreadthDeps["validate"]
  readonly repairEvaluatePredicate: RepairBreadthDeps["validateInputs"]["evaluatePredicate"]
  readonly runCandidates: ReturnType<typeof makeRepairBreadthRunCandidates> | undefined
  readonly acceptanceSelectCandidates: ReturnType<typeof makeAcceptanceSelectCandidates>
  readonly acceptanceSelection: { current?: { tier: RerankTier; winningPatch: string } }
}

const buildRepairPhaseInputs = (
  instance: Instance,
  deps: RunInstanceDeps,
  sandbox: string,
  signal: AbortSignal,
  w: Wiring,
  repair: NonNullable<RunInstanceDeps["repair"]>,
  precomputedHint: string | undefined,
  reproHint: string | undefined,
  closureHint: string | undefined,
  primaryRailStep: PrimaryRailStep | undefined,
  reproSources: readonly string[],
  ownerNearRegressionSet: readonly string[],
  issueDeclaredExpected: IssueDeclaredExpected | undefined,
  postureOverride: BenchPosture | undefined,
  stateOverride: BenchKnobState | undefined,
  chaMultisiteSteer: string | undefined,
  chaRepairTargets: readonly ChaRepairTarget[] | undefined,
  perCandidateSeed: PerCandidateSeed | undefined,
): RepairPhaseInputs => {
  // jun-25 — suppress the localize-phase EDIT-BLOCK for repair rounds. The fault
  // is already localized in repair (patch exists + failing gate named), so the
  // Phase-1 edit-block is a straitjacket that re-fires every fresh repair session
  // and forces ~5 wasted re-localize turns against the "revise the patch now"
  // seed. We resolve the EFFECTIVE posture here (the override, or the env-derived
  // posture `runAgentOnce`→`buildConfig` would otherwise compute) and strip
  // `phase1Turns` so `decideLocalizePhase` never blocks — the advisory steer is
  // preserved. INITIAL generation (`runAgentPhase`) is unchanged.
  const resolvedPosture =
    postureOverride ??
    benchPostureFromState(stateOverride ?? resolveBenchKnobs({ envVars: process.env }), process.env)
  const repairPosture = repairLocalizePhaseSuppressed(resolvedPosture)
  // B1/B3: thread the slice-resolving inputs into the classic-repair packet so
  // its owner evidence carries exact slices (paired with issue symbols) and it
  // names the active proof target — parity with the selector-repair sibling.
  const repairIssueSymbols = extractIssueHint(instance.problemStatement).symbols
  const repairLlmEvidence: Partial<LlmEvidenceArtifacts> = {}
  // #2 repro-vote: when the knob is on AND we have a reproducing set, the
  // validator becomes the K-of-N RESOLVED majority vote (re-run the set on the
  // patched tree). Empty sources, execution failure, and inconclusive votes are
  // fail-closed inside that validator. Default-OFF returns `baseValidate`
  // unchanged. The exec wiring lives in the SHARED `buildReproVoteValidate` so
  // both drivers agree.
  const validate = buildReproVoteValidate(
    instance,
    reproSources,
    repair.validate ?? defaultValidate,
    deps.reproArtifactRootPath,
  )
  // jun-26 repair spec gate / jun-28 strong-oracle: when the issue declares a
  // concrete PUBLIC expected output AND the spec-gate OR strong-oracle knob is on,
  // wrap the typed-predicate evaluator so the repair rail ALSO requires that
  // declared expected in the observed output. The wrapper turns an exit-0 round
  // whose output lacks the declared expected into a predicate `matched:false`,
  // which `isFalseGreen` (and the strong-oracle conjunction) then read. NO-LEAK:
  // `issueDeclaredExpected` is public-issue-text provenance only (the matcher
  // re-asserts the answer-key guard). Both knobs OFF ⇒ the raw evaluator
  // (byte-identical). `buildSpecGateEvaluatePredicate(base, undefined)` is identity.
  const repairEvaluatePredicate = resolveRepairEvaluatePredicate(
    repairPosture,
    issueDeclaredExpected,
    evaluateSuccessPredicate,
  )
  // jun-28 repair-loop BREADTH (shared with apps/bench/eval/driver.ts via the
  // exported `buildRepairBreadthRunCandidates`): B>1 ⇒ fan a repair round out to
  // B forked candidates, continue from the validator-green one (else best signal).
  // B=1 ⇒ undefined ⇒ legacy single path (byte-identical). The runner threads
  // `chaMultisiteSteer` into the forked agent; that divergence lives in the
  // injected `runAgentOnFork` closure (the app omits it).
  const repairBreadth = repair.breadth ?? repairPosture.repairBreadth
  const runCandidates = buildRepairBreadthRunCandidates({
    instance,
    deps,
    sandbox,
    signal,
    repairPosture,
    repairBreadth,
    validate,
    repairEvaluatePredicate,
    primaryRailStep,
    chaRepairTargets,
    perCandidateSeed,
    runAgentOnFork: (forkSandbox, seedMsg, laneLlm) =>
      runAgentOnce(
        instance,
        deps,
        forkSandbox,
        signal,
        w,
        seedMsg,
        deps.timeoutMs,
        precomputedHint,
        reproHint,
        closureHint,
        repairPosture,
        stateOverride,
        chaMultisiteSteer,
        laneLlm,
      ),
  })
  // jun-30 SOTA++ acceptance: dual-guard the repair chooser on BOTH the
  // reproducing set and the owner-near PUBLIC regression set that was confirmed
  // green on the base tree during preparation. Empty set ⇒ repro-only legacy.
  // OBSERVE-ONLY: capture the last acceptance selection (tier + its winning patch).
  // We do NOT blindly trust last-wins: a later repair round can fall back to a
  // NON-selected `runOnce` patch (breadth fan-out fully failed), which would leave
  // a STALE tier attributed to a patch acceptance never chose. After the loop we
  // emit the tier ONLY if this selection's winner is the finally-submitted patch
  // (`out.patch`). tier-3 dominance on Pro ⇒ the ladder gave no real selection.
  const acceptanceSelection: { current?: { tier: RerankTier; winningPatch: string } } = {}
  const acceptanceSelectCandidates = makeAcceptanceSelectCandidates(
    instance,
    reproSources,
    sandbox,
    deps.timeoutMs,
    repairPosture.acceptance,
    ownerNearRegressionSet,
    resolveAcceptanceLlmRerank(instance, deps.llm, signal),
    (t) => {
      acceptanceSelection.current = { tier: t.tier, winningPatch: t.winningPatch }
    },
  )
  return {
    repairPosture,
    repairBreadth,
    repairIssueSymbols,
    repairLlmEvidence,
    validate,
    repairEvaluatePredicate,
    runCandidates,
    acceptanceSelectCandidates,
    acceptanceSelection,
  }
}

export const runRepairPhase = async (
  instance: Instance,
  deps: RunInstanceDeps,
  sandbox: string,
  signal: AbortSignal,
  w: Wiring,
  repair: NonNullable<RunInstanceDeps["repair"]>,
  precomputedHint: string | undefined,
  reproHint: string | undefined,
  closureHint: string | undefined,
  primaryRailStep: PrimaryRailStep | undefined,
  siblingOwners: readonly string[],
  reproSources: readonly string[],
  ownerNearRegressionSet: readonly string[],
  verificationTarget: VerificationTargetFact | undefined,
  /** jun-26 repair spec gate / jun-28 strong-oracle: PUBLIC issue-declared expected
   *  output (from the closure session). Composed into the repair `evaluatePredicate`
   *  ONLY when `repairSpecGate` or `repairStrongOracle` is on; absent / both off ⇒
   *  the raw evaluator is used (byte-identical). */
  issueDeclaredExpected: IssueDeclaredExpected | undefined,
  postureOverride?: BenchPosture,
  stateOverride?: BenchKnobState,
  chaMultisiteSteer?: string,
  chaRepairTargets?: readonly ChaRepairTarget[],
  /** Strategy #7 location-set fanout: per-candidate seed factory (built from the
   *  localizer's ranked files). Absent ⇒ breadth candidates share the base seed
   *  (byte-identical). Passed into the repair-breadth deps. */
  perCandidateSeed?: PerCandidateSeed,
): Promise<Phase> => {
  // Setup (posture / validator / predicate / breadth-seed / acceptance chooser)
  // is derived in `buildRepairPhaseInputs`; this orchestrator runs the rounds.
  const {
    repairPosture,
    repairBreadth,
    repairIssueSymbols,
    repairLlmEvidence,
    validate,
    repairEvaluatePredicate,
    runCandidates,
    acceptanceSelectCandidates,
    acceptanceSelection,
  } = buildRepairPhaseInputs(
    instance,
    deps,
    sandbox,
    signal,
    w,
    repair,
    precomputedHint,
    reproHint,
    closureHint,
    primaryRailStep,
    reproSources,
    ownerNearRegressionSet,
    issueDeclaredExpected,
    postureOverride,
    stateOverride,
    chaMultisiteSteer,
    chaRepairTargets,
    perCandidateSeed,
  )
  const { patch, out } = await runRepairRoundsInSnapshot({
    instance,
    deps,
    sandbox,
    w,
    repair,
    repairPosture,
    repairBreadth,
    validate,
    repairEvaluatePredicate,
    primaryRailStep,
    runCandidates,
    acceptanceSelectCandidates,
    siblingOwners,
    repairIssueSymbols,
    verificationTarget,
    repairLlmEvidence,
    runOnce: (seedMsg) =>
      runAgentOnce(
        instance,
        deps,
        sandbox,
        signal,
        w,
        seedMsg,
        deps.timeoutMs,
        precomputedHint,
        reproHint,
        closureHint,
        // Repair posture with the localize-phase edit-block stripped; explicit so
        // `buildConfig` does NOT re-resolve the block-active env posture.
        repairPosture,
        stateOverride,
        chaMultisiteSteer,
      ),
  })
  // `patch` (withGitSnapshot's final diff) is the canonical capture; fall back to
  // the orchestrator's last-round view. They agree by construction (single sandbox).
  const capturedPatch = patch !== "" ? patch : out.patch
  const submissionReview = maybeReviewSubmission(capturedPatch)
  // Spec step-5 observe-only fix-free viability label (default-OFF ⇒ undefined ⇒
  // byte-identical; fail-open, never diverts control flow). Reuses `reproSources`
  // (the ACTUAL reproduce_issue.py bodies already threaded into this phase).
  const reproViabilityReview = await maybeReviewReproViability({
    llm: deps.llm,
    problemStatement: instance.problemStatement,
    reproSources,
    capturedPatch,
    signal,
  })
  const acceptanceTier = attributeAcceptanceTier(acceptanceSelection.current, out.patch)
  return {
    patch: capturedPatch,
    turns: out.turns,
    validated: out.validated,
    primaryFalseGreen: out.primaryFalseGreen,
    primaryFalseRed: out.primaryFalseRed,
    ...(out.validationDecision !== undefined
      ? { repairValidationDecision: out.validationDecision }
      : {}),
    ...(out.rounds > 0 ? { verifyRounds: out.rounds } : {}),
    ...(Object.keys(repairLlmEvidence).length > 0 ? { llmEvidence: repairLlmEvidence } : {}),
    ...(submissionReview !== undefined ? { submissionReview } : {}),
    ...(reproViabilityReview !== undefined ? { reproViabilityReview } : {}),
    // Attribute the tier ONLY when the last selection's winner IS the submitted
    // patch (`out.patch` = orchestrator final `prevRun.patch`, same string lineage
    // as the adapter's `selected.patch`). A trailing non-selected fallback round
    // changes `out.patch` ⇒ no attribution. Pure seam ⇒ unit-tested.
    ...(acceptanceTier !== undefined ? { acceptanceTier } : {}),
  }
}
