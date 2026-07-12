/**
 * Per-attempt CONTEXT preparation + MAIN phase dispatch (pure code motion from
 * `driver.ts`, byte-identical). `prepareAttemptContext` does all the pre-agent
 * work — hint/repro context, owner resolution, closure session, verification
 * plan, repair-gate eligibility, strict-LSP grounding proof — and returns the
 * frozen `PreparedAttemptContext`. `runMainPhase` routes an attempt to the
 * selection / repair / single-pass path and `maybeValidateTerminalResult`
 * applies the terminal gold-sanity. Depends on the extracted phase runners +
 * localize-prep + result-assembly; runtime edges only, no load-time cycle.
 */

import { extractIssueHint, pytestReportPathFor } from "@/agent"
import { type OwnerSibling, resolveOwnerSiblings } from "@/agent/closure"
import { startBackgroundLspPrewarm } from "@/agent/lsp-bridge"
import { type LLMPort, laneLabeledPort } from "@/llm"
import type { BenchObserver } from "../../observe"
import { emitLocalize } from "../../report"
import type { BenchReproTestTelemetry, Instance, InstanceResult } from "../../types"
import { buildClosureSession, type ClosureSessionState } from "../closure-session"
import { validateGoldPatch } from "../gold-sanity"
import { normalizeRepoPath } from "../impacted-test-discovery"
import {
  type BenchKnobState,
  type BenchPosture,
  benchPostureFromState,
  resolveBenchKnobs,
} from "../knobs-bench"
import { buildIntakeLlmEvidencePacket, verificationTargetFromPlan } from "../llm-evidence-packet"
import { buildRepairFanoutFiles, buildRepairFanoutSymbols } from "../location-set-fanout"
import { buildCleanSelectionAuthorityContracts } from "../public-contract-bundle"
import {
  benchInstallsReproHint,
  benchRunsRepairPhase,
  benchShouldRunRepairPhase,
} from "../repair-phase-policy"
import type { Wiring } from "../report"
import type { ReproArtifactSink } from "../repro-artifacts-sink"
import { filesFromPatch } from "../selection-executor"
import { witnessStructuralOwnerCandidates } from "../static-witness"
import { buildAstStaticWitnesses } from "../static-witness-adapter"
import {
  discoverVerificationModuleSmokePlan,
  type VerificationModuleSmokePlan,
} from "../verification-module-smoke"
import { extractVerificationOwnerTestExpectations } from "../verification-owner-test-expectations"
import {
  discoverVerificationOwnerTestsPlan,
  type VerificationOwnerTestsPlan,
} from "../verification-owner-tests"
import { runAgentPhase } from "./agent-phase"
import {
  cleanUniqueList,
  type HintReproContext,
  type Phase,
  type PreparedAttemptContext,
  type RunInstanceDeps,
  readSandboxSource,
  stage1FilesOf,
} from "./context-types"
import { prepareIssueHint, resolveChaMultisiteContext } from "./localize-prep"
import { runRepairPhase } from "./repair-phase"
import { verifyStrictPresetLspGrounding } from "./repo-source-scan"
import {
  installReproTestHint,
  prepareSelectionReproSources,
  reproValidationCmdForInstance,
} from "./repro-test-prep"
import {
  attachLateFailureArtifacts,
  shouldValidateGold,
  terminalAgentResult,
} from "./result-assembly"
import { runSelectionPhase } from "./selection-phase"
import { resolveLocationFanoutSeeder } from "./selection-port-factories"

const prepareHintAndReproContext = async (
  instance: Instance,
  sandbox: string,
  llm: LLMPort,
  posture: BenchPosture,
  reproArtifactSink?: ReproArtifactSink,
  /** F1 — the SHARED per-attempt observer (from `Wiring`). When present, the
   *  file-tree build + localize outcome is emitted as a `localize` trace so
   *  post-mortem localization RCA can see truncation / candidate breadth. Absent
   *  ⇒ no-op (behaviour-neutral), same gate as `emitSandbox`. */
  observer?: BenchObserver,
): Promise<HintReproContext> => {
  let localizeCandidates: readonly string[] = []
  const precomputedHint = await prepareIssueHint(instance, sandbox, posture.issueHintMode, {
    // Phase lane → recorded as metadata.lane, so the localize turns group under
    // one authoritative "localize" band in the viewer (replay-neutral label).
    llm: laneLabeledPort(llm, "localize"),
    issueHintExpectedActual: posture.issueHintExpectedActual,
    renderObservations: posture.renderObservations,
    lspPrefetch: posture.lspPrefetch,
    ...(posture.localizeBudget !== undefined ? { localizeBudget: posture.localizeBudget } : {}),
    onCandidates: (files) => {
      localizeCandidates = files
    },
    // F1 — emit the truncation + candidate-breadth trace through the SHARED
    // observer (no-op when unbound). Kept behind the observer gate so a
    // non-observing run stays byte-identical.
    onLocalize: (data) => emitLocalize(observer, data),
  })
  const chaMultisite = await resolveChaMultisiteContext({
    instance,
    sandbox,
    posture,
    localizeCandidates,
  })
  const reproInstall = benchInstallsReproHint(posture.inLoopExecMode)
    ? await installReproTestHint(instance, sandbox, posture, llm, reproArtifactSink)
    : { hint: undefined, telemetry: undefined }
  const selectionRepro =
    reproInstall.telemetry !== undefined
      ? {
          telemetry: reproInstall.telemetry,
          hint: reproInstall.hint,
          reproSources: reproInstall.reproSources ?? [],
          hardeningReproSources: reproInstall.hardeningReproSources ?? [],
        }
      : await prepareSelectionReproSources(instance, sandbox, llm, posture)
  return {
    posture,
    precomputedHint,
    chaMultisiteSteer: chaMultisite.steer,
    chaRepairTargets: chaMultisite.repairTargets,
    localizeCandidates,
    reproHint: reproInstall.hint ?? selectionRepro.hint,
    reproTest: selectionRepro.telemetry,
    reproSources: selectionRepro.reproSources,
    hardeningReproSources: selectionRepro.hardeningReproSources,
  }
}

const resolveOwnerResolved = async (args: {
  readonly instance: Instance
  readonly posture: BenchPosture
  readonly stage1Files: readonly { file: string; score: number }[]
  readonly sandbox: string
  readonly signal: AbortSignal
}): Promise<readonly OwnerSibling[] | undefined> => {
  if (
    !(args.instance.swebench !== undefined && args.posture.faultEvidence && args.posture.lspNav)
  ) {
    return undefined
  }
  return resolveOwnerSiblings()({
    stage1Files: args.stage1Files,
    issueText: args.instance.problemStatement,
    cwd: args.sandbox,
    readSource: (rel) => readSandboxSource(args.sandbox, rel),
    signal: args.signal,
  })
}

const verificationOwnerCandidatesOf = (args: {
  readonly witnessOwners?: readonly { file: string; forSymbol?: string }[]
  readonly ownerResolved: readonly OwnerSibling[] | undefined
  readonly stage1Files: readonly { file: string; score: number }[]
}): readonly string[] =>
  cleanUniqueList([
    ...(args.witnessOwners?.map((owner) => owner.file) ?? []),
    ...(args.ownerResolved?.map((owner) => owner.file) ?? []),
    ...args.stage1Files.map((file) => file.file),
  ])

const buildClosureAttemptState = (args: {
  readonly instance: Instance
  readonly posture: BenchPosture
  readonly stage1Files: readonly { file: string; score: number }[]
  readonly ownerResolved: readonly OwnerSibling[] | undefined
  readonly witnessOwners?: readonly { file: string; forSymbol?: string }[]
  readonly reproTest: BenchReproTestTelemetry | undefined
  readonly ownerNearTests?: readonly string[]
  readonly ownerNearPrimaryBaseValidatedRed?: boolean
  readonly touchedModuleSmoke?: readonly string[]
  readonly moduleSmokePrimaryBaseValidatedRed?: boolean
}): ClosureSessionState | undefined =>
  args.instance.swebench === undefined
    ? undefined
    : buildClosureSession({
        problemStatement: args.instance.problemStatement,
        stage1Files: args.stage1Files,
        ...(args.ownerResolved !== undefined ? { ownerResolved: args.ownerResolved } : {}),
        ...(args.witnessOwners && args.witnessOwners.length > 0
          ? { witnessOwners: args.witnessOwners }
          : {}),
        ...(args.reproTest?.installed === true && args.reproTest.reproducedCount > 0
          ? {
              reproScript: {
                cmd: reproValidationCmdForInstance(args.instance, args.reproTest.path),
                pytestReportPath: pytestReportPathFor(args.reproTest.path),
                baseValidatedRed: true,
              },
            }
          : {}),
        ...(args.ownerNearTests !== undefined && args.ownerNearTests.length > 0
          ? { ownerNearTests: args.ownerNearTests }
          : {}),
        ...(args.ownerNearPrimaryBaseValidatedRed === true
          ? { ownerNearPrimaryBaseValidatedRed: true }
          : {}),
        ...(args.touchedModuleSmoke !== undefined && args.touchedModuleSmoke.length > 0
          ? { touchedModuleSmoke: args.touchedModuleSmoke }
          : {}),
        ...(args.moduleSmokePrimaryBaseValidatedRed === true
          ? { moduleSmokePrimaryBaseValidatedRed: true }
          : {}),
        posture: {
          lspNav: args.posture.lspNav,
          primaryRail: args.posture.primaryRail,
          faultEvidence: args.posture.faultEvidence,
        },
        // T-OWN-12 activation: clean presets use rule-based AUTHORITATIVE owner
        // admission (public issue-named owners only), bypassing the additive
        // heuristic score/lead-gap. Structural static-witness evidence stays
        // advisory. Research mode passes false ⇒ legacy admission is byte-identical
        // (closure-session applies the clean rule only on `true`).
        ownerClean: args.posture.selectorMode === "clean",
      })

const resolveRepairState = (args: {
  readonly deps: RunInstanceDeps
  readonly instance: Instance
  readonly posture: BenchPosture
  readonly closureSession: ClosureSessionState | undefined
}): Pick<
  PreparedAttemptContext,
  "effectiveRepair" | "repairGateEligible" | "gateDecisionVerify" | "runRepair"
> => {
  const effectiveRepair =
    args.deps.repair ??
    (args.posture.repairRounds !== undefined ? { maxRounds: args.posture.repairRounds } : undefined)
  const repairGateEligible = benchRunsRepairPhase(
    effectiveRepair !== undefined,
    args.instance.swebench !== undefined,
    args.posture.inLoopExecMode,
  )
  const gateDecisionVerify =
    repairGateEligible && args.closureSession?.bundle.gate.action === "verify"
  const runRepair =
    effectiveRepair !== undefined &&
    benchShouldRunRepairPhase({
      eligible: repairGateEligible,
      primaryRailEnabled: args.posture.primaryRail,
      gateAction: args.closureSession?.bundle.gate.action,
      primaryRailStep: args.closureSession?.primaryRailStep,
      verificationPlan: args.closureSession?.bundle.plan,
    })
  return { effectiveRepair, repairGateEligible, gateDecisionVerify, runRepair }
}

/** T3 — merge forward-localize consumer owners into the stage-1 candidate set.
 *  Pure relocation of the localize-candidate → stage-1 assembly out of
 *  `prepareAttemptContext` (byte-identical). Input = the localize candidates plus
 *  the optional forward-localize owners; output = the deduped stage-1 file list. */
const mergeForwardLocalizeStage1Files = (
  hintRepro: { readonly localizeCandidates: readonly string[] },
  forwardLocalizeOwners: readonly string[] | undefined,
): readonly { file: string; score: number }[] => {
  // T3 — forward-localize consumers enter as low-score ADDITIONAL owner candidates
  // (they widen the set; ranking still prefers backward-localized owners). score 0
  // keeps them below any positively-ranked stage-1 file. DEDUP against the stage-1
  // set so a consumer already backward-localized is not double-listed (which would
  // skew owner-coverage counts and waste a candidate-family slot).
  const stage1Localized = stage1FilesOf(hintRepro.localizeCandidates)
  // DEDUP by NORMALIZED path: stage1FilesOf keeps the raw localize-candidate paths
  // while forwardLocalizeOwners are already `normalizeRepoPath`'d, so a raw-vs-raw
  // Set compare silently never matches (audit R2). Normalize BOTH sides of the
  // membership test so a consumer already backward-localized is truly dropped.
  const stage1Seen = new Set(stage1Localized.map((entry) => normalizeRepoPath(entry.file)))
  const stage1Files = [
    ...stage1Localized,
    ...(forwardLocalizeOwners ?? [])
      .filter((file) => !stage1Seen.has(normalizeRepoPath(file)))
      .map((file) => ({ file, score: 0 })),
  ]
  return stage1Files
}

export const prepareAttemptContext = async (
  instance: Instance,
  sandbox: string,
  deps: RunInstanceDeps,
  signal: AbortSignal,
  postureOverride?: BenchPosture,
  stateOverride?: BenchKnobState,
  /** T3 — forward-localize consumer files traced from the PRIOR adaptive
   *  candidate (deeper_localize route). Merged into the localized owner set as
   *  ADDITIONAL candidates for this pass. Absent ⇒ byte-identical (first pass /
   *  knob off). Never hard `requiredFiles` — only T1 static-edge validation can
   *  promote a site to a coverage requirement. */
  forwardLocalizeOwners?: readonly string[],
  /** F1 — the SHARED per-attempt observer (from `Wiring`) so the localize step
   *  can emit its file-tree build + outcome trace. Trailing-optional so the
   *  composition caller stays source-compatible; ABSENT ⇒ no `localize` trace is
   *  emitted (byte-identical to the pre-F1 path). The caller in the batch driver
   *  passes `wiring.observer` to light this up. */
  observer?: BenchObserver,
): Promise<PreparedAttemptContext> => {
  const state = stateOverride ?? resolveBenchKnobs({ envVars: process.env })
  const posture = postureOverride ?? benchPostureFromState(state, process.env)
  // jul-6 — as soon as the repo (sandbox) is confirmed, fire-and-forget a pyright
  // prewarm so it indexes DURING the (slow) strict-LSP-grounding + agentless-localize
  // steps below — maximizing the chance a WARM server answers the localize-time
  // lsp-prefetch harvest (the A/B telemetry showed a cold repo misses the 5s budget).
  // NO-THROW + gated on the observation LSP path; the warm-pool persists, so a repair
  // round's critic and the agent's own lsp_nav benefit too. `void`: never blocks prep.
  if (posture.lspPrefetch) void startBackgroundLspPrewarm(sandbox, signal)
  // The gold patch's targets are the files the task actually concerns ⇒ the
  // language to require grounding for. Absent (non-swebench) ⇒ undefined, and the
  // gate falls back to the whole-repo probe (historical behavior).
  const taskFiles = instance.goldPatch ? filesFromPatch(instance.goldPatch) : undefined
  const lspGrounding = await verifyStrictPresetLspGrounding(posture, sandbox, taskFiles, signal)
  const hintRepro = await prepareHintAndReproContext(
    instance,
    sandbox,
    deps.llm,
    posture,
    deps.reproArtifactSink,
    observer,
  )
  const stage1Files = mergeForwardLocalizeStage1Files(hintRepro, forwardLocalizeOwners)
  const ownerResolved = await resolveOwnerResolved({
    instance,
    posture: hintRepro.posture,
    stage1Files,
    sandbox,
    signal,
  })
  // SCAFF-03: digest typed-relation static witnesses into structural owner
  // candidate files. These stay advisory in clean owner admission; they seed
  // localization / repair evidence and owner-near test discovery, but they do
  // NOT by themselves admit a clean owner or mint required contracts.
  const witnessOwners =
    instance.swebench === undefined
      ? []
      : witnessStructuralOwnerCandidates(
          buildAstStaticWitnesses({
            problemStatement: instance.problemStatement,
            ownerCandidates: stage1Files.map((f) => f.file),
            ...(ownerResolved !== undefined ? { ownerResolved } : {}),
            readSource: (rel) => readSandboxSource(sandbox, rel),
          }),
        )
  // Structural fallback: even when no synthesized repro validated red, the
  // closure plan should still be able to name PUBLIC repo tests near the best
  // owner candidates. These commands guide verification / repair planning only;
  // final clean submit authority still comes from executed proof ports.
  const ownerCandidates = verificationOwnerCandidatesOf({
    witnessOwners,
    ownerResolved,
    stage1Files,
  })
  const ownerNearTestPlan: VerificationOwnerTestsPlan =
    instance.swebench === undefined ||
    !(hintRepro.posture.verificationPlan || hintRepro.posture.primaryRail)
      ? { commands: [], testPaths: [], baseGreenTestPaths: [], primaryBaseState: "unavailable" }
      : await discoverVerificationOwnerTestsPlan({
          instance,
          sandbox,
          timeoutMs: deps.timeoutMs,
          ownerCandidates,
        })
  const ownerNearTests = ownerNearTestPlan.commands
  const ownerNearRegressionSet = ownerNearTestPlan.baseGreenTestPaths
  const ownerNearPrimaryBaseValidatedRed = ownerNearTestPlan.primaryBaseState === "red"
  const moduleSmokePlan: VerificationModuleSmokePlan =
    instance.swebench === undefined ||
    !(hintRepro.posture.verificationPlan || hintRepro.posture.primaryRail)
      ? { commands: [], primaryBaseState: "unavailable" }
      : await discoverVerificationModuleSmokePlan({
          instance,
          sandbox,
          timeoutMs: deps.timeoutMs,
        })
  const touchedModuleSmoke = moduleSmokePlan.commands
  const moduleSmokePrimaryBaseValidatedRed = moduleSmokePlan.primaryBaseState === "red"
  // T2 — command-derived test paths take precedence; when empty, the extractor
  // falls back to a bounded convention-based source search over the localized
  // owner modules (only files that exist are read). Gated to the SAME condition
  // as `ownerNearTests` (swebench + verification-plan/primary-rail), so the
  // fallback never injects expectations into instances that have no closure plan.
  const existingTestExpectations =
    instance.swebench === undefined ||
    !(hintRepro.posture.verificationPlan || hintRepro.posture.primaryRail)
      ? []
      : await extractVerificationOwnerTestExpectations({
          sandbox,
          ownerNearTests,
          localizedOwnerFiles: ownerCandidates,
          issueSymbols: extractIssueHint(instance.problemStatement).symbols,
        })
  const closureSession = buildClosureAttemptState({
    instance,
    posture: hintRepro.posture,
    stage1Files,
    ownerResolved,
    witnessOwners,
    reproTest: hintRepro.reproTest,
    ownerNearTests,
    ...(ownerNearPrimaryBaseValidatedRed ? { ownerNearPrimaryBaseValidatedRed } : {}),
    ...(touchedModuleSmoke.length > 0 ? { touchedModuleSmoke } : {}),
    ...(moduleSmokePrimaryBaseValidatedRed ? { moduleSmokePrimaryBaseValidatedRed } : {}),
  })
  const intakeLlmEvidence = buildIntakeLlmEvidencePacket({
    problemStatement: instance.problemStatement,
    localizeCandidates: hintRepro.localizeCandidates,
    ...(closureSession?.bundle.evidence !== undefined
      ? { faultEvidence: closureSession.bundle.evidence }
      : {}),
    ...(closureSession?.bundle.plan !== undefined
      ? { verificationPlan: closureSession.bundle.plan }
      : {}),
    ...(hintRepro.reproTest !== undefined ? { reproTest: hintRepro.reproTest } : {}),
  })
  return {
    ...hintRepro,
    state,
    ownerResolved,
    closureSession,
    verificationPlan: closureSession?.bundle.plan,
    existingTestExpectations,
    ownerNearRegressionSet,
    primaryRailStep: closureSession?.primaryRailStep,
    closureHint: closureSession?.closureHint,
    intakeLlmEvidence,
    lspGrounding,
    ...resolveRepairState({
      deps,
      instance,
      posture: hintRepro.posture,
      closureSession,
    }),
  }
}

export const runMainPhase = async (args: {
  readonly instance: Instance
  readonly deps: RunInstanceDeps
  readonly sandbox: string
  readonly signal: AbortSignal
  readonly wiring: Wiring
  readonly prepared: PreparedAttemptContext
}): Promise<Phase> => {
  if (args.prepared.posture.verifySelectN !== undefined && args.instance.swebench !== undefined) {
    const publicContracts = buildCleanSelectionAuthorityContracts({
      declaredExpected: args.prepared.closureSession?.issueDeclaredExpected,
      candidates: args.prepared.closureSession?.bundle.evidence.candidates,
      apiSymbols: args.prepared.closureSession?.bundle.evidence.issueSymbols,
    })
    return runSelectionPhase(
      args.instance,
      args.deps,
      args.sandbox,
      args.signal,
      args.wiring,
      args.prepared.posture.verifySelectN,
      args.prepared.posture.verifySelectConcurrency,
      args.prepared.posture.verifySelectEarlyAccept,
      args.prepared.posture.verifySelectRiskGate,
      args.prepared.posture.verifySelectLlmRiskGate,
      args.prepared.posture.verifySelectCounterfactual,
      args.prepared.posture.selectorMode,
      args.prepared.posture.verifySelectProofRequired,
      publicContracts,
      args.prepared.posture.verifySelectRegression,
      args.prepared.posture.regressionMaxTests,
      args.prepared.posture.verifySelectRepro,
      args.prepared.closureSession?.bundle.evidence.candidates.map((c) => c.file) ??
        args.prepared.localizeCandidates,
      args.prepared.ownerResolved,
      args.prepared.verificationPlan?.baseValidatedRed ?? false,
      args.prepared.verificationPlan,
      args.prepared.existingTestExpectations,
      args.prepared.reproTest,
      args.prepared.precomputedHint,
      args.prepared.reproHint,
      args.prepared.closureHint,
      args.prepared.reproSources,
      args.prepared.hardeningReproSources,
      args.prepared.posture,
      args.prepared.state,
      args.prepared.chaMultisiteSteer,
      args.prepared.chaRepairTargets,
    )
  }
  if (args.prepared.runRepair && args.prepared.effectiveRepair !== undefined) {
    const repairFanoutFiles = buildRepairFanoutFiles({
      localizeCandidates: args.prepared.localizeCandidates,
      stage1Files: args.prepared.closureSession?.input.evidence.stage1Files,
      ownerResolved: args.prepared.ownerResolved,
      witnessOwners: args.prepared.closureSession?.input.evidence.witnessOwners,
    })
    return runRepairPhase(
      args.instance,
      args.deps,
      args.sandbox,
      args.signal,
      args.wiring,
      args.prepared.effectiveRepair,
      args.prepared.precomputedHint,
      args.prepared.reproHint,
      args.prepared.closureHint,
      args.prepared.primaryRailStep,
      args.prepared.ownerResolved?.map((o) => o.file) ?? [],
      args.prepared.reproSources,
      args.prepared.ownerNearRegressionSet,
      verificationTargetFromPlan(args.prepared.verificationPlan),
      args.prepared.closureSession?.issueDeclaredExpected,
      args.prepared.posture,
      args.prepared.state,
      args.prepared.chaMultisiteSteer,
      args.prepared.chaRepairTargets,
      resolveLocationFanoutSeeder(
        args.prepared.posture.locationFanout,
        repairFanoutFiles,
        args.prepared.effectiveRepair.breadth ?? args.prepared.posture.repairBreadth,
        buildRepairFanoutSymbols({
          issueSymbols: extractIssueHint(args.instance.problemStatement).symbols,
          fanoutFiles: repairFanoutFiles,
          ownerResolved: args.prepared.ownerResolved,
          witnessOwners: args.prepared.closureSession?.input.evidence.witnessOwners,
        }),
      ),
    )
  }
  return runAgentPhase(
    args.instance,
    args.deps,
    args.sandbox,
    args.signal,
    args.wiring,
    args.prepared.precomputedHint,
    args.prepared.reproHint,
    args.prepared.closureHint,
    args.prepared.posture,
    args.prepared.state,
    args.prepared.chaMultisiteSteer,
  )
}

export const maybeValidateTerminalResult = async (args: {
  readonly instance: Instance
  readonly phase: Phase
  readonly reproTest: BenchReproTestTelemetry | undefined
  readonly deps: RunInstanceDeps
  readonly wiring: Wiring
  readonly startedAt: number
  readonly signal: AbortSignal
  readonly prepared: PreparedAttemptContext
  readonly sandbox: string
}): Promise<InstanceResult | undefined> => {
  const terminal = terminalAgentResult(args)
  if (terminal === undefined) return undefined
  let result = terminal
  if (shouldValidateGold(args.deps, false)) {
    const gold = await validateGoldPatch(args.instance, { ...args.deps, signal: args.signal })
    if (!gold.ok) {
      const { error: _prevError, ...rest } = result
      result = { ...rest, passed: false, verdict: "grader_invalid", error: gold.error }
    }
  }
  const extra: Partial<InstanceResult> = {}
  attachLateFailureArtifacts({
    extra,
    instance: args.instance,
    sandbox: args.sandbox,
    phase: args.phase,
    prepared: args.prepared,
  })
  return { ...result, ...extra }
}
