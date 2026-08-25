/**
 * Per-attempt CONTEXT preparation + MAIN phase dispatch (pure code motion from
 * `driver.ts`, byte-identical). `prepareAttemptContext` does all the pre-agent
 * work — hint/repro context, owner resolution, closure session, verification
 * plan, repair-gate eligibility, strict-LSP grounding proof — and returns the
 * frozen `PreparedAttemptContext`. `maybeValidateTerminalResult` applies the
 * terminal gold-sanity. (The per-instance main-phase orchestrator lives in the
 * app driver `src/apps/bench/eval/driver.ts`; the runner core only prepares the
 * context + validates.) Depends on the extracted phase runners + localize-prep +
 * result-assembly; runtime edges only, no load-time cycle.
 */

import { extractIssueHint, pytestReportPathFor } from "@/agent"
import { type OwnerSibling, resolveOwnerSiblings } from "@/agent/closure"
import { startBackgroundLspPrewarm } from "@/agent/lsp-bridge"
import type { ObservationBundle } from "@/agent/observation/fragment"
import {
  computeFailureSourceDigest,
  type FailureFactsExtraction,
  type FailureFactsIdentity,
} from "@/agent/observation/metrics"
import { type LLMPort, laneLabeledPort } from "@/llm"
import { errMessage, logger } from "@/shared"
import {
  attemptFactsRecordPath,
  commitAttemptFacts,
  type FactsStoreIO,
  nodeFactsStoreIO,
} from "../../failure-facts"
import type { AttemptObservation, BenchObserver } from "../../observe"
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
import { buildIntakeLlmEvidencePacket } from "../llm-evidence-packet"
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
import {
  cleanUniqueList,
  type HintReproContext,
  type Phase,
  type PreparedAttemptContext,
  type RunInstanceDeps,
  readSandboxSource,
  stage1FilesOf,
} from "./context-types"
import {
  type FailureFactsWiring,
  prepareIssueHint,
  resolveChaMultisiteContext,
} from "./localize-prep"
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

/** The localize-seam failure-facts wiring PLUS the bundle observer that binds its
 *  expected source digest. Both ride the SAME `prepareIssueHint` call. */
interface LocalizeFailureFactsSeam {
  readonly failureFacts: FailureFactsWiring
  readonly onObservationBundle: (bundle: ObservationBundle) => void
}

/**
 * RFC-07 G4 — build the PRODUCTION failure-facts wiring for the live localize
 * seam. This is the provider that makes G3's `extractFailureFacts` actually run
 * in production (its only prior caller was a test) and PERSIST its output inline
 * with the per-attempt facts record via the G4 atomic writer.
 *
 * Identity: `runId` + `<instanceId>.<attempt>` are the caller's EXACT binding.
 * The source digest is only knowable once the live bundle is built inside
 * `prepareIssueHint`; `onObservationBundle` fires with that SAME bundle
 * immediately before the failure-facts seam, so we capture the live digest there
 * and bind it as the expected source. A freshly-built per-attempt bundle has no
 * crossed stream, so this is the truthful self-consistent binding (run/attempt
 * stay the meaningful strict axes); `extractFailureFacts` still recomputes and
 * re-checks the digest, so a divergence remains representable.
 *
 * A mismatched / incomplete extraction routes to `commitAttemptFacts`, which
 * REJECTS it (nothing persisted) — never a partial record.
 */
export const buildLocalizeFailureFactsSeam = (
  observe: AttemptObservation,
  instanceId: string,
  io: FactsStoreIO = nodeFactsStoreIO,
): LocalizeFailureFactsSeam => {
  const attempt = observe.attempt ?? 0
  const attemptId = `${instanceId}.${attempt}`
  const factsPath = attemptFactsRecordPath(observe.dir, observe.runId, instanceId, attempt)
  let liveSourceDigest = ""
  const expected: FailureFactsIdentity = {
    runId: observe.runId,
    attemptId,
    get sourceDigest() {
      return liveSourceDigest
    },
  }
  const persist = (extraction: FailureFactsExtraction): void => {
    // BEST-EFFORT: failure-facts persistence is observe-only and MUST NOT abort
    // the attempt (the seam docs pin it as pure observation). The atomic writer
    // still guarantees no PARTIAL record lands on a write fault — we only swallow
    // the throw here so an IO hiccup degrades to "facts unavailable", never a
    // failed instance. `commitAttemptFacts` itself stays strict (throws) so the
    // atomicity unit test can observe the failure.
    try {
      commitAttemptFacts(io, factsPath, extraction)
    } catch (e) {
      logger.warn("observation: failure-facts persist failed (observe-only, ignored)", {
        error: errMessage(e),
      })
    }
  }
  return {
    onObservationBundle: (bundle) => {
      liveSourceDigest = computeFailureSourceDigest(bundle)
    },
    failureFacts: {
      expected,
      capturedUnder: { runId: observe.runId, attemptId },
      onFacts: (facts) => persist({ kind: "extracted", facts }),
      onUnavailable: (outcome) => persist(outcome),
    },
  }
}

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
  /** RFC-07 G4 — the per-attempt observation handle (run/attempt/dir). Present ⇒
   *  the live localize seam derives versioned failure-facts and PERSISTS them via
   *  the G4 atomic writer. Absent ⇒ byte-identical (no facts wiring, no write),
   *  same default-OFF gate as observation itself. */
  observe?: AttemptObservation,
): Promise<HintReproContext> => {
  let localizeCandidates: readonly string[] = []
  // RFC-07 G4 — construct the production failure-facts seam once (gated on the
  // observe handle, so a non-observing run stays byte-identical: no wiring, no
  // extractor run, no write).
  const factsSeam =
    observe !== undefined ? buildLocalizeFailureFactsSeam(observe, instance.id) : undefined
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
    // RFC-07 G4 — the live failure-facts seam + the bundle observer that binds
    // its expected source digest. Both ride this same call (default-OFF absent).
    ...(factsSeam !== undefined
      ? {
          failureFacts: factsSeam.failureFacts,
          onObservationBundle: factsSeam.onObservationBundle,
        }
      : {}),
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

/** `xs` when it is present AND non-empty, else `undefined` — for closure inputs
 *  an empty list means the same thing as no list at all.
 *
 *  WHY THIS IS A UNIT: that one rule was spelled THREE times inside
 *  {@link buildClosureAttemptState}'s argument literal, in two different
 *  dialects (`a && a.length > 0` for `witnessOwners`, `a !== undefined &&
 *  a.length > 0` for the other two). Naming it once removes the drift risk and
 *  leaves each call site as a plain presence test. */
const nonEmptyOrUndefined = <T>(xs: readonly T[] | undefined): readonly T[] | undefined =>
  xs !== undefined && xs.length > 0 ? xs : undefined

/**
 * Assemble the closure-session inputs for this attempt (or `undefined` for a
 * non-swebench instance, which has no closure plan).
 *
 * WHY IT IS SHAPED THIS WAY: the complexity here was never the field count — it
 * was that the whole argument literal sat inside a single
 * `swebench === undefined ? undefined : ...` TERNARY, so all eight conditional
 * spreads were at nesting depth 1 and each cost DOUBLE. Turning that ternary
 * into an early return is the entire structural fix: the same eight gates, none
 * of the surcharge. The three list gates then route through
 * {@link nonEmptyOrUndefined} so "present and non-empty" is stated once.
 */
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
}): ClosureSessionState | undefined => {
  if (args.instance.swebench === undefined) return undefined
  const witnessOwners = nonEmptyOrUndefined(args.witnessOwners)
  const ownerNearTests = nonEmptyOrUndefined(args.ownerNearTests)
  const touchedModuleSmoke = nonEmptyOrUndefined(args.touchedModuleSmoke)
  return buildClosureSession({
    problemStatement: args.instance.problemStatement,
    stage1Files: args.stage1Files,
    ...(args.ownerResolved !== undefined ? { ownerResolved: args.ownerResolved } : {}),
    ...(witnessOwners !== undefined ? { witnessOwners } : {}),
    ...(args.reproTest?.installed === true && args.reproTest.reproducedCount > 0
      ? {
          reproScript: {
            cmd: reproValidationCmdForInstance(args.instance, args.reproTest.path),
            pytestReportPath: pytestReportPathFor(args.reproTest.path),
            baseValidatedRed: true,
          },
        }
      : {}),
    ...(ownerNearTests !== undefined ? { ownerNearTests } : {}),
    ...(args.ownerNearPrimaryBaseValidatedRed === true
      ? { ownerNearPrimaryBaseValidatedRed: true }
      : {}),
    ...(touchedModuleSmoke !== undefined ? { touchedModuleSmoke } : {}),
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
}

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

/**
 * Is the closure-planning half of attempt prep active for this instance?
 *
 * WHY THIS IS A UNIT: this exact two-part gate — a swebench instance AND a
 * posture that asked for either a verification plan or the primary rail — was
 * spelled THREE times verbatim inside {@link prepareAttemptContext}, guarding
 * `ownerNearTests`, `moduleSmoke` and `existingTestExpectations`. Three
 * spellings of one rule is three chances to drift, and it accounted for nine of
 * the function's cognitive points on its own (each site: a ternary + two
 * boolean sequences). Named once, each site becomes a plain flag test — and the
 * three consumers are now guaranteed to move together, which matters: T2's
 * expectation extractor is deliberately gated to the SAME condition as
 * `ownerNearTests` so the fallback never injects expectations into an instance
 * that has no closure plan.
 */
const closurePlanningEnabled = (instance: Instance, posture: BenchPosture): boolean =>
  instance.swebench !== undefined && (posture.verificationPlan || posture.primaryRail)

/** SCAFF-03: digest typed-relation static witnesses into structural owner
 *  candidate files. These stay advisory in clean owner admission; they seed
 *  localization / repair evidence and owner-near test discovery, but they do
 *  NOT by themselves admit a clean owner or mint required contracts.
 *
 *  WHY A UNIT: a non-swebench instance has no witnesses at all, so the whole
 *  AST-witness build hangs off one presence gate — an early return, not a
 *  ternary wrapped around a four-argument call. */
const buildWitnessOwners = (
  instance: Instance,
  sandbox: string,
  stage1Files: readonly { file: string; score: number }[],
  ownerResolved: readonly OwnerSibling[] | undefined,
): readonly { file: string; forSymbol?: string }[] => {
  if (instance.swebench === undefined) return []
  return witnessStructuralOwnerCandidates(
    buildAstStaticWitnesses({
      problemStatement: instance.problemStatement,
      ownerCandidates: stage1Files.map((f) => f.file),
      ...(ownerResolved !== undefined ? { ownerResolved } : {}),
      readSource: (rel) => readSandboxSource(sandbox, rel),
    }),
  )
}

/** OPC-07 intake packet inputs. WHY A UNIT: three independent "forward it only
 *  when this pass actually produced it" spreads over the SAME two sources
 *  (the closure bundle and the repro telemetry) — one concern, and it kept the
 *  caller paying for three conditional spreads inline. */
const buildIntakeEvidence = (
  problemStatement: string,
  localizeCandidates: readonly string[],
  reproTest: BenchReproTestTelemetry | undefined,
  closureSession: ClosureSessionState | undefined,
) =>
  buildIntakeLlmEvidencePacket({
    problemStatement,
    localizeCandidates,
    ...(closureSession?.bundle.evidence !== undefined
      ? { faultEvidence: closureSession.bundle.evidence }
      : {}),
    ...(closureSession?.bundle.plan !== undefined
      ? { verificationPlan: closureSession.bundle.plan }
      : {}),
    ...(reproTest !== undefined ? { reproTest } : {}),
  })

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
    // RFC-07 G4 — the observe handle lights up the live failure-facts persist
    // seam (default-OFF when observation is unwired).
    deps.observe,
  )
  const stage1Files = mergeForwardLocalizeStage1Files(hintRepro, forwardLocalizeOwners)
  const ownerResolved = await resolveOwnerResolved({
    instance,
    posture: hintRepro.posture,
    stage1Files,
    sandbox,
    signal,
  })
  const witnessOwners = buildWitnessOwners(instance, sandbox, stage1Files, ownerResolved)
  // ONE gate for the whole closure-planning half of prep — see
  // {@link closurePlanningEnabled}. Read from `hintRepro.posture` (the posture
  // the hint/repro step may have refined), never the raw `posture`.
  const planningEnabled = closurePlanningEnabled(instance, hintRepro.posture)
  // Structural fallback: even when no synthesized repro validated red, the
  // closure plan should still be able to name PUBLIC repo tests near the best
  // owner candidates. These commands guide verification / repair planning only;
  // final clean submit authority still comes from executed proof ports.
  const ownerCandidates = verificationOwnerCandidatesOf({
    witnessOwners,
    ownerResolved,
    stage1Files,
  })
  const ownerNearTestPlan: VerificationOwnerTestsPlan = !planningEnabled
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
  const moduleSmokePlan: VerificationModuleSmokePlan = !planningEnabled
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
  const existingTestExpectations = !planningEnabled
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
  const intakeLlmEvidence = buildIntakeEvidence(
    instance.problemStatement,
    hintRepro.localizeCandidates,
    hintRepro.reproTest,
    closureSession,
  )
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
