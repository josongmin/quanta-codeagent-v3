/**
 * Per-instance RESULT assembly (pure code motion from `driver.ts`,
 * byte-identical). Two cohesive halves: (1) the result BUILDERS — the terminal
 * `InstanceResult` shapes for ok / no-patch / generation-failure / env-prep-fail
 * plus the phase→error classifiers; (2) the observed-success + closure + late-
 * failure ARTIFACT attachers and `verifyAndFinalizeResult` (the ONE official
 * verify + gold-sanity + artifact stamping at the end of an attempt). Depends on
 * `./context-types` + leaf report/score siblings; `prepareAttemptContext` is a
 * runtime edge into `./attempt-context` (late-failure re-derivation only).
 */

import { errMessage, foldGroundingReceipts, type LspGroundingReceipt } from "@/shared"
import type { BenchReproTestTelemetry, Instance, InstanceResult } from "../../types"
import { isCaptureFailure } from "../capture-correctness"
import { buildPhasePatchHygiene } from "../closure-session"
import { validateGoldPatch } from "../gold-sanity"
import { buildSelectionExplanationPacket, type LlmEvidenceArtifacts } from "../llm-evidence-packet"
import { noPatchExhaustedErrorOf } from "../no-patch-breaker-adapter"
import { buildPhasePatchBudget } from "../patch-budget-admission"
import { emitPatch, emitVerify, ObservationError, type Wiring } from "../report"
import { reproArtifactInstancePath } from "../repro-artifacts-fs"
import { labelForReceipt, type ReceiptEvidence, researchKnobTouched } from "../score-label"
import { relFromSandbox } from "../stream-tap"
import { verify } from "../verdict"
import type { Phase, PreparedAttemptContext, RunInstanceDeps } from "./context-types"
import { benchOptIns } from "./env-knob-parse"
import { adaptiveRepairEscalationDecision } from "./localize-prep"
import { StrictLspGroundingDegradedError } from "./repo-source-scan"

export const okResult = (
  instance: Instance,
  phase: Phase,
  v: { passed: boolean; error?: string },
  extra: Partial<InstanceResult>,
): InstanceResult => {
  const keepTerminalAuthority = phase.stopReason !== "error" && phase.stopReason !== "refusal"
  return {
    id: instance.id,
    passed: v.passed,
    patch: phase.patch,
    turns: phase.turns,
    ...(keepTerminalAuthority && phase.stopReason !== undefined
      ? { stopReason: phase.stopReason }
      : {}),
    ...(v.error !== undefined ? { error: v.error } : {}),
    ...extra,
  }
}

export const reproResultExtra = (
  reproTest: BenchReproTestTelemetry | undefined,
  reproArtifactPath: string | undefined,
): Partial<InstanceResult> =>
  reproTest === undefined && reproArtifactPath === undefined
    ? {}
    : {
        ...(reproTest !== undefined ? { reproTest } : {}),
        ...(reproArtifactPath !== undefined ? { reproArtifactPath } : {}),
      }

export const reproArtifactPathOf = (
  deps: RunInstanceDeps,
  instance: Instance,
): string | undefined =>
  deps.reproArtifactRootPath !== undefined
    ? reproArtifactInstancePath(deps.reproArtifactRootPath, instance.id)
    : undefined

export const shouldValidateGold = (deps: RunInstanceDeps, agentPassed: boolean): boolean =>
  deps.goldSanity !== undefined && (deps.goldSanity.mode === "always" || agentPassed === false)

const agentPhaseError = (phase: Phase): string | undefined => {
  // T5 — a capture-desync (successful source edits observed but an empty done-time
  // diff) is an INFRA fault, not a model miss. On the SINGLE-PASS path the agent can
  // stop `completed` with an empty patch, so the generic stopReason branches below
  // would mislabel it real-fail/completed_unresolved (never retried). Surface the
  // `capture_lost_edits` marker here so classifyOutcome's CAPTURE_DESYNC_RE routes it
  // to infra-fail/retry — symmetric with the selection path's isCaptureFailure throw.
  // Gated on a lost-edits captureClass ⇒ byte-identical for every other run.
  if (
    phase.captureClass !== undefined &&
    isCaptureFailure(phase.captureClass) &&
    phase.patch.trim() === ""
  ) {
    return phase.agentError ?? "capture_lost_edits: source edits observed but done-time diff empty"
  }
  const patchCaptureMiss = patchCaptureMissErrorOf(phase)
  if (patchCaptureMiss !== undefined) return patchCaptureMiss
  const noPatchExhausted = noPatchExhaustedErrorOf({
    enabled: benchOptIns().noPatchBreaker,
    stopReason: phase.stopReason,
    patch: phase.patch,
    ...(phase.editCount !== undefined ? { editCount: phase.editCount } : {}),
  })
  if (noPatchExhausted !== undefined) return noPatchExhausted
  if (phase.stopReason === "max_turns" && phase.patch.trim() === "") {
    return "agent reached max turns before verification"
  }
  if (phase.stopReason === "error" && phase.patch.trim() === "") {
    return phase.agentError ?? "agent stopped with error before verification"
  }
  if (phase.stopReason === "refusal" && phase.patch.trim() === "") {
    return "agent stopped with refusal before verification"
  }
  if (phase.stopReason === "aborted" && phase.patch.trim() === "") {
    return "agent aborted before verification"
  }
  if (phase.stopReason === "budget_exhausted" && phase.patch.trim() === "") {
    return "agent exhausted token budget before verification"
  }
  return undefined
}

const patchCaptureMissErrorOf = (phase: Phase): string | undefined =>
  // Gate on SOURCE-applied edits, not raw churn. A run that edited ONLY a
  // test/scratch file then timed out (raw editCount>0, sourceAppliedEditCount=0)
  // is a genuine no-source-edit timeout — NOT a capture desync — and must fall
  // through to the normal `timeout` classification (no retry). Capture-miss fires
  // ONLY when a real source edit was applied yet the captured diff is empty.
  phase.patch.trim() === "" &&
  phase.stopReason === "aborted" &&
  (phase.sourceAppliedEditCount ?? 0) > 0
    ? "patch capture miss: agent edited files before abort, but final git diff was empty"
    : undefined

/** T5b (django__django-11138 class) — did verify-select DISCARD a real non-empty
 *  candidate to an EMPTY submission? True iff the winner is null AND at least one
 *  SCORED candidate produced a non-empty patch (non-empty `files` ⇔ a captured
 *  diff). This is a measurement hole, not a model miss: the model demonstrably
 *  produced fix(es) but the harness submitted nothing, so grading an EMPTY patch as
 *  `completed_unresolved` (a "graded, did not resolve" verdict) is a lie — the same
 *  laundering confound this project fences for throttle/empty-patch and lost-edits.
 *
 *  EXCLUDES the proof-required withholds (`proof_required_missing` /
 *  `proof_infra_blocked`): those are DELIBERATE model-discipline withholds owned by
 *  the proof-gate, not a capture/laundering hole — they keep their own wording and
 *  classification. Pure + deterministic; no thresholds. */
const selectionDiscardedRealCandidate = (phase: Phase): boolean => {
  const tel = phase.selectionTelemetry
  if (tel === undefined || tel.winnerId !== null) return false
  if (
    tel.noWinnerReason === "proof_required_missing" ||
    tel.noWinnerReason === "proof_infra_blocked"
  ) {
    return false
  }
  return tel.candidates.some((candidate) => candidate.files.length > 0)
}

const noWinnerTerminalReasonOf = (phase: Phase): string => {
  if (phase.selectionTelemetry?.noWinnerReason === "proof_required_missing") {
    return "verify-select proof-required mode produced no submittable candidate (no candidate achieved positive executed public proof)"
  }
  if (phase.selectionTelemetry?.noWinnerReason === "proof_infra_blocked") {
    return "verify-select proof-required mode produced no submittable candidate (public proof execution was infra-blocked)"
  }
  // T5b — a real non-empty candidate existed but was discarded to an empty submit.
  // Surface the `selection_discarded_real_candidate` marker so `classifyOutcome`'s
  // SELECTION_DISCARD_RE routes it to infra-fail/retry instead of laundering the
  // empty patch into `completed_unresolved`. The generic no-candidate-produced case
  // (every candidate empty) keeps the plain wording ⇒ stays a real model miss.
  if (selectionDiscardedRealCandidate(phase)) {
    return "selection_discarded_real_candidate: verify-select produced no submittable candidate but ≥1 candidate generated a non-empty patch that was hard-rejected, so the EMPTY submission is an infra/measurement hole, not a model miss"
  }
  return "verify-select produced no submittable candidate (every candidate was either hard-rejected, empty, or did not apply)"
}

const selectionNoWinnerErrorOf = (phase: Phase): string | undefined => {
  if (phase.selectionTelemetry?.winnerId !== null) return undefined
  return agentPhaseError(phase) ?? noWinnerTerminalReasonOf(phase)
}

const generationFailureResult = (args: {
  readonly instance: Instance
  readonly phase: Phase
  readonly generationError: string
  readonly reproTest: BenchReproTestTelemetry | undefined
  readonly deps: RunInstanceDeps
  readonly wiring: Wiring
  readonly startedAt: number
}): InstanceResult => {
  const reproArtifactPath = reproArtifactPathOf(args.deps, args.instance)
  const extra: Partial<InstanceResult> = {
    ...reproResultExtra(args.reproTest, reproArtifactPath),
    ...(args.phase.reproOracleCalibration !== undefined
      ? { reproOracleCalibration: args.phase.reproOracleCalibration }
      : {}),
    ...(args.phase.selectionTelemetry !== undefined
      ? { selectionTelemetry: args.phase.selectionTelemetry }
      : {}),
  }
  if (args.deps.observe && args.wiring.observer) {
    extra.verdict = "ok"
    extra.durationMs = Date.now() - args.startedAt
    extra.patchPath = emitPatch(
      args.deps.observe,
      args.instance,
      args.wiring.observer,
      args.phase.patch,
    )
    const usage = args.wiring.usage?.total()
    if (usage) extra.usage = usage
  }
  return {
    id: args.instance.id,
    passed: false,
    patch: args.phase.patch,
    turns: args.phase.turns,
    ...(args.phase.stopReason !== undefined ? { stopReason: args.phase.stopReason } : {}),
    error: args.generationError,
    ...extra,
  }
}

const noPatchResult = (args: {
  readonly instance: Instance
  readonly phase: Phase
  readonly reproTest: BenchReproTestTelemetry | undefined
  readonly deps: RunInstanceDeps
  readonly wiring: Wiring
  readonly startedAt: number
}): InstanceResult => {
  const reproArtifactPath = reproArtifactPathOf(args.deps, args.instance)
  const extra: Partial<InstanceResult> = {
    ...reproResultExtra(args.reproTest, reproArtifactPath),
    ...(args.phase.reproOracleCalibration !== undefined
      ? { reproOracleCalibration: args.phase.reproOracleCalibration }
      : {}),
    ...(args.phase.selectionTelemetry !== undefined
      ? { selectionTelemetry: args.phase.selectionTelemetry }
      : {}),
  }
  if (args.deps.observe && args.wiring.observer) {
    extra.verdict = "ok"
    extra.durationMs = Date.now() - args.startedAt
    extra.patchPath = emitPatch(
      args.deps.observe,
      args.instance,
      args.wiring.observer,
      args.phase.patch,
    )
    const usage = args.wiring.usage?.total()
    if (usage) extra.usage = usage
  }
  const noWinnerError = patchCaptureMissErrorOf(args.phase) ?? selectionNoWinnerErrorOf(args.phase)
  return {
    id: args.instance.id,
    passed: false,
    patch: args.phase.patch,
    turns: args.phase.turns,
    ...(args.phase.stopReason !== undefined ? { stopReason: args.phase.stopReason } : {}),
    ...(noWinnerError !== undefined ? { error: noWinnerError } : {}),
    ...extra,
  }
}

export const terminalAgentResult = (args: {
  readonly instance: Instance
  readonly phase: Phase
  readonly reproTest: BenchReproTestTelemetry | undefined
  readonly deps: RunInstanceDeps
  readonly wiring: Wiring
  readonly startedAt: number
}): InstanceResult | undefined => {
  if (
    args.phase.patch.trim() === "" &&
    args.phase.selectionTelemetry?.winnerId === null &&
    args.phase.stopReason !== "error" &&
    args.phase.stopReason !== "refusal"
  ) {
    return noPatchResult(args)
  }
  const generationError = agentPhaseError(args.phase)
  if (generationError !== undefined) {
    return generationFailureResult({ ...args, generationError })
  }
  if (args.phase.patch.trim() === "") return noPatchResult(args)
  return undefined
}

export const envPrepFailedResult = (
  instance: Instance,
  prep: { readonly code: number; readonly stderr: string },
): InstanceResult => ({
  id: instance.id,
  passed: false,
  patch: "",
  turns: 0,
  verdict: "env_prep_failed",
  error: `env prep (setupCmd) failed (code ${prep.code}): ${prep.stderr.slice(0, 500)}`,
})

const validateVerifiedOutcome = async (args: {
  readonly instance: Instance
  readonly deps: RunInstanceDeps
  readonly signal: AbortSignal
  readonly verified: Awaited<ReturnType<typeof verify>>
}): Promise<{
  readonly verified: Awaited<ReturnType<typeof verify>>
  readonly graderInvalid: boolean
  /** Solvability oracle: gold resolved (true) / gold failed (false) / gold-sanity didn't run
   *  (undefined). Persisted per-instance so the platform can curate verifier-sound instances. */
  readonly goldResolved: boolean | undefined
}> => {
  if (!shouldValidateGold(args.deps, args.verified.passed)) {
    return { verified: args.verified, graderInvalid: false, goldResolved: undefined }
  }
  const gold = await validateGoldPatch(args.instance, { ...args.deps, signal: args.signal })
  if (gold.ok) return { verified: args.verified, graderInvalid: false, goldResolved: true }
  const { error: _prevError, ...rest } = args.verified
  return {
    verified: { ...rest, passed: false, error: gold.error },
    graderInvalid: true,
    goldResolved: false,
  }
}

const attachObservedSuccessBasics = (args: {
  readonly extra: Partial<InstanceResult>
  readonly deps: RunInstanceDeps
  readonly instance: Instance
  readonly wiring: Wiring
  readonly phase: Phase
  readonly verified: Awaited<ReturnType<typeof verify>>
  readonly startedAt: number
}): void => {
  if (!(args.deps.observe && args.wiring.observer)) return
  args.extra.verdict ??= "ok"
  args.extra.durationMs = Date.now() - args.startedAt
  args.extra.patchPath = emitPatch(
    args.deps.observe,
    args.instance,
    args.wiring.observer,
    args.phase.patch,
  )
  emitVerify(args.wiring.observer, args.verified)
  const usage = args.wiring.usage?.total()
  if (usage) args.extra.usage = usage
  if (args.phase.firstEditFile !== undefined) args.extra.firstEditFile = args.phase.firstEditFile
  if (args.phase.editCount !== undefined) args.extra.editCount = args.phase.editCount
  if (args.phase.turnsToFirstEdit !== undefined)
    args.extra.turnsToFirstEdit = args.phase.turnsToFirstEdit
}

const attachLspClosureMetric = (
  extra: Partial<InstanceResult>,
  lspGrounding: LspGroundingReceipt | undefined,
): void => {
  if (lspGrounding === undefined) return
  const status = foldGroundingReceipts([lspGrounding])
  if (status !== undefined) extra.lspGrounding = status
}

const attachPrimaryRailMetrics = (args: {
  readonly extra: Partial<InstanceResult>
  readonly phase: Phase
  readonly prepared: PreparedAttemptContext
}): void => {
  if (!(args.prepared.posture.verificationPlan || args.prepared.posture.primaryRail)) return
  args.extra.primaryRailPresent = args.prepared.primaryRailStep !== undefined
  args.extra.requiredVerificationCovered =
    args.prepared.verificationPlan?.required.some((s) => s.successPredicate !== undefined) ?? false
  if (args.prepared.verificationPlan !== undefined)
    args.extra.synthReproBaseRed = args.prepared.verificationPlan.baseValidatedRed
  if (args.prepared.primaryRailStep !== undefined && args.phase.primaryFalseGreen !== undefined) {
    args.extra.primaryFalseGreen = args.phase.primaryFalseGreen
  }
  if (args.prepared.primaryRailStep !== undefined && args.phase.primaryFalseRed !== undefined) {
    args.extra.primaryFalseRed = args.phase.primaryFalseRed
  }
}

const attachRepairGateMetrics = (args: {
  readonly extra: Partial<InstanceResult>
  readonly phase: Phase
  readonly prepared: PreparedAttemptContext
}): void => {
  if (!args.prepared.repairGateEligible) return
  args.extra.gateEntered = args.prepared.gateDecisionVerify
  args.extra.gateBypassed = !args.prepared.gateDecisionVerify
  if (args.phase.verifyRounds !== undefined) args.extra.verifyRounds = args.phase.verifyRounds
  if (args.phase.repairValidationDecision !== undefined) {
    args.extra.repairValidationDecision = args.phase.repairValidationDecision
  }
}

const attachClosureMetrics = (args: {
  readonly extra: Partial<InstanceResult>
  readonly phase: Phase
  readonly prepared: PreparedAttemptContext
}): void => {
  // LSP-02: carry the strict gate's typed grounding receipt into the report as a
  // folded status so the report/CLI render the SAME outcome the gate proved.
  attachLspClosureMetric(args.extra, args.prepared.lspGrounding)
  attachPrimaryRailMetrics(args)
  attachRepairGateMetrics(args)
  // OBSERVE-ONLY acceptance tier — UNCONDITIONAL (not behind repairGateEligible):
  // it is selection telemetry, not a gate decision, so it must surface for any
  // repair run that routed through the rerank ladder (e.g. non-`full`/non-swebench
  // modes too), not only gate-eligible ones. Absent ⇒ omitted (byte-identical).
  if (args.phase.acceptanceTier !== undefined) {
    args.extra.acceptanceTier = args.phase.acceptanceTier
  }
}

const attachLlmEvidenceArtifacts = (args: {
  readonly extra: Partial<InstanceResult>
  readonly instance: Instance
  readonly phase: Phase
  readonly prepared: PreparedAttemptContext
}): void => {
  const selectionExplanation =
    args.phase.selectionTelemetry === undefined
      ? undefined
      : buildSelectionExplanationPacket({
          problemStatement: args.instance.problemStatement,
          ownerFiles: args.phase.selectionTelemetry.ownerFiles,
          winnerId: args.phase.selectionTelemetry.winnerId,
          ...(args.phase.selectionTelemetry.noWinnerReason !== undefined
            ? { noWinnerReason: args.phase.selectionTelemetry.noWinnerReason }
            : {}),
          ...(args.phase.selectionTelemetry.proofRequired === true ? { proofRequired: true } : {}),
          ...(args.phase.selectionTelemetry.proofSummary !== undefined
            ? { proofSummary: args.phase.selectionTelemetry.proofSummary }
            : {}),
          candidates: args.phase.selectionTelemetry.candidates,
        })
  const llmEvidence: LlmEvidenceArtifacts = {
    intake: args.prepared.intakeLlmEvidence,
    ...(args.phase.llmEvidence ?? {}),
    ...(selectionExplanation !== undefined ? { selectionExplanation } : {}),
  }
  if (Object.keys(llmEvidence).length > 0) args.extra.llmEvidence = llmEvidence
}

const attachSelectionAndClosureArtifacts = (args: {
  readonly extra: Partial<InstanceResult>
  readonly instance: Instance
  readonly sandbox: string
  readonly phase: Phase
  readonly prepared: PreparedAttemptContext
}): void => {
  const { posture, verificationPlan, closureSession, primaryRailStep, ownerResolved } =
    args.prepared
  if (args.phase.reproOracleCalibration !== undefined) {
    args.extra.reproOracleCalibration = args.phase.reproOracleCalibration
  }
  if (args.phase.selectionTelemetry !== undefined) {
    args.extra.selectionTelemetry = args.phase.selectionTelemetry
  }
  if (args.phase.ownerWidening !== undefined) {
    args.extra.ownerWidening = args.phase.ownerWidening
  }
  if (args.phase.submissionReview !== undefined) {
    args.extra.submissionReview = args.phase.submissionReview
  }
  attachLlmEvidenceArtifacts(args)
  const ownerHint = relFromSandbox(args.sandbox, args.phase.firstEditFile)
  const hygiene =
    args.instance.swebench !== undefined
      ? buildPhasePatchHygiene(args.phase.patch, ownerHint)
      : undefined
  if (posture.patchHygiene && hygiene !== undefined) {
    args.extra.patchHygiene = hygiene
    args.extra.outOfScopeFiles = hygiene.filesOutsideOwner.length > 0
  }
  if ((posture.patchBudget || posture.patchBudgetStrict) && args.instance.swebench !== undefined) {
    args.extra.patchBudget = buildPhasePatchBudget({
      patch: args.phase.patch,
      repo: args.instance.swebench.repo,
      closureSession,
      strict: posture.patchBudgetStrict,
    })
  }
  if (posture.verificationPlan && verificationPlan !== undefined) {
    args.extra.verificationPlan = verificationPlan
  }
  if (posture.faultEvidence && closureSession !== undefined) {
    args.extra.faultEvidence = closureSession.bundle.evidence
    args.extra.ownerAdmission = closureSession.bundle.owner
  }
  if (posture.repairEscalation && closureSession !== undefined) {
    // Telemetry attachment only AT THIS LATE SITE: the same decision helper now
    // also feeds the adaptive reroute seam (`adaptiveRepairEscalationOwners`)
    // before the next `prepareAttemptContext`, but assigning it to `args.extra`
    // here remains report-only because the phase has already finished.
    const repairEscalation = adaptiveRepairEscalationDecision({
      prepared: {
        posture,
        closureSession,
        ownerResolved,
        primaryRailStep,
      },
      phase: args.phase,
    })
    if (repairEscalation !== undefined) args.extra.repairEscalation = repairEscalation
  }
}

export const attachLateFailureArtifacts = (args: {
  readonly extra: Partial<InstanceResult>
  readonly instance: Instance
  readonly sandbox: string
  readonly phase: Phase
  readonly prepared: PreparedAttemptContext
}): void => {
  attachClosureMetrics({ extra: args.extra, phase: args.phase, prepared: args.prepared })
  attachSelectionAndClosureArtifacts({
    extra: args.extra,
    instance: args.instance,
    sandbox: args.sandbox,
    phase: args.phase,
    prepared: args.prepared,
  })
}

export const latePhaseFailureResultOf = (args: {
  readonly instance: Instance
  readonly phase: Phase
  readonly reproTest: BenchReproTestTelemetry | undefined
  readonly reproArtifactPath?: string
  readonly error: string
  readonly verdict?: InstanceResult["verdict"]
  readonly prepared?: PreparedAttemptContext
  readonly sandbox?: string
}): InstanceResult => {
  const extra: Partial<InstanceResult> = {
    ...reproResultExtra(args.reproTest, args.reproArtifactPath),
    ...(args.phase.stopReason !== undefined ? { stopReason: args.phase.stopReason } : {}),
    ...(args.phase.firstEditFile !== undefined ? { firstEditFile: args.phase.firstEditFile } : {}),
    ...(args.phase.editCount !== undefined ? { editCount: args.phase.editCount } : {}),
    ...(args.phase.turnsToFirstEdit !== undefined
      ? { turnsToFirstEdit: args.phase.turnsToFirstEdit }
      : {}),
    ...(args.phase.primaryFalseGreen !== undefined
      ? { primaryFalseGreen: args.phase.primaryFalseGreen }
      : {}),
    ...(args.phase.primaryFalseRed !== undefined
      ? { primaryFalseRed: args.phase.primaryFalseRed }
      : {}),
    ...(args.phase.repairValidationDecision !== undefined
      ? { repairValidationDecision: args.phase.repairValidationDecision }
      : {}),
    ...(args.phase.verifyRounds !== undefined ? { verifyRounds: args.phase.verifyRounds } : {}),
    ...(args.phase.reproOracleCalibration !== undefined
      ? { reproOracleCalibration: args.phase.reproOracleCalibration }
      : {}),
    ...(args.phase.selectionTelemetry !== undefined
      ? { selectionTelemetry: args.phase.selectionTelemetry }
      : {}),
  }
  if (args.prepared !== undefined && args.sandbox !== undefined) {
    attachLateFailureArtifacts({
      extra,
      instance: args.instance,
      sandbox: args.sandbox,
      phase: args.phase,
      prepared: args.prepared,
    })
  }
  return {
    id: args.instance.id,
    passed: false,
    patch: args.phase.patch,
    turns: args.phase.turns,
    ...extra,
    ...(args.verdict !== undefined ? { verdict: args.verdict } : {}),
    error: args.error,
  }
}

const _latePhaseFailureResultFromError = (args: {
  readonly instance: Instance
  readonly phase: Phase
  readonly reproTest: BenchReproTestTelemetry | undefined
  readonly error: unknown
  readonly prepared: PreparedAttemptContext | undefined
  readonly sandbox: string
}): InstanceResult => {
  if (args.error instanceof ObservationError) {
    return latePhaseFailureResultOf({
      instance: args.instance,
      phase: args.phase,
      reproTest: args.reproTest,
      verdict: "degraded",
      error: `observation failed (strict): ${args.error.message}`,
      ...(args.prepared !== undefined ? { prepared: args.prepared, sandbox: args.sandbox } : {}),
    })
  }
  if (args.error instanceof StrictLspGroundingDegradedError) {
    const result = latePhaseFailureResultOf({
      instance: args.instance,
      phase: args.phase,
      reproTest: args.reproTest,
      verdict: "degraded",
      error: args.error.message,
      ...(args.prepared !== undefined ? { prepared: args.prepared, sandbox: args.sandbox } : {}),
    })
    // The gate threw before a PreparedAttemptContext existed, so attach the typed
    // status directly from the receipt (LSP-02) — the degraded report row still
    // carries the launch/ready outcome enum, not just the error string.
    const status =
      args.error.receipt !== undefined ? foldGroundingReceipts([args.error.receipt]) : undefined
    return status !== undefined ? { ...result, lspGrounding: status } : result
  }
  return latePhaseFailureResultOf({
    instance: args.instance,
    phase: args.phase,
    reproTest: args.reproTest,
    error: errMessage(args.error),
    ...(args.prepared !== undefined ? { prepared: args.prepared, sandbox: args.sandbox } : {}),
  })
}

/** RFC jun-29 #2 (measurement-hole, audit R3): a swebench MAIN-grade INFRA failure is a
 *  measurement hole, NOT a model miss. `verify` (verdict.ts) sets `error` on a non-pass
 *  ONLY for the harness `gradingCompleted:false` / refuse-to-fake-grade path — never for a
 *  genuine patch-fail — so this triple is the precise infra signal. The caller marks it
 *  `grader_invalid` so the resolvedTotals denominator EXCLUDES it (else a Pro image-pull /
 *  harness crash is laundered into a real miss — the throttle-miss confound). Pure +
 *  exported for unit test (`buildSuccessfulResultExtra` is not exported). */
export const isSwebenchInfraGradeFailure = (
  instance: Pick<Instance, "swebench">,
  verified: Pick<Awaited<ReturnType<typeof verify>>, "passed" | "error">,
): boolean => instance.swebench !== undefined && !verified.passed && verified.error !== undefined

/** Decide the measurement-hole verdict for a finalized result: `"grader_invalid"` (⇒
 *  resolvedTotals EXCLUDES it from the denominator) when EITHER the gold-sanity check failed
 *  (`graderInvalid`) OR the main grade hit a swebench infra failure; otherwise `undefined`
 *  (a normal result that stays in the denominator). Extracted + exported so the predicate→
 *  verdict WIRING is unit-testable (`buildSuccessfulResultExtra` is not exported) — a mutant
 *  dropping the infra branch is then caught, not silently green. */
export const swebenchGraderInvalidVerdict = (
  graderInvalid: boolean,
  instance: Pick<Instance, "swebench">,
  verified: Pick<Awaited<ReturnType<typeof verify>>, "passed" | "error">,
): "grader_invalid" | undefined =>
  graderInvalid || isSwebenchInfraGradeFailure(instance, verified) ? "grader_invalid" : undefined

const buildSuccessfulResultExtra = (args: {
  readonly instance: Instance
  readonly sandbox: string
  readonly phase: Phase
  readonly verified: Awaited<ReturnType<typeof verify>>
  readonly reproTest: BenchReproTestTelemetry | undefined
  readonly deps: RunInstanceDeps
  readonly wiring: Wiring
  readonly startedAt: number
  readonly prepared: PreparedAttemptContext
  readonly graderInvalid: boolean
  readonly goldResolved: boolean | undefined
}): Partial<InstanceResult> => {
  const reproArtifactPath = reproArtifactPathOf(args.deps, args.instance)
  const extra: Partial<InstanceResult> = reproResultExtra(args.reproTest, reproArtifactPath)
  // Solvability oracle: persist the gold-sanity outcome per instance (RFC jun-29).
  if (args.goldResolved !== undefined) extra.goldResolved = args.goldResolved
  // RFC jun-29 #2 (measurement-hole, audit R3): EITHER a gold-sanity failure (`graderInvalid`)
  // OR a swebench MAIN-grade INFRA failure — `verify` sets `error` ONLY on the official/Pro
  // harness `gradingCompleted:false` / refuse-to-fake-grade path (verdict.ts), never on a
  // genuine patch-fail — is `grader_invalid` so `resolvedTotals` EXCLUDES it from the
  // denominator; else a Pro image-pull / harness crash is laundered into a real miss.
  const graderVerdict = swebenchGraderInvalidVerdict(
    args.graderInvalid,
    args.instance,
    args.verified,
  )
  if (graderVerdict !== undefined) extra.verdict = graderVerdict
  attachObservedSuccessBasics({ ...args, extra })
  attachClosureMetrics({ extra, phase: args.phase, prepared: args.prepared })
  attachSelectionAndClosureArtifacts({
    extra,
    instance: args.instance,
    sandbox: args.sandbox,
    phase: args.phase,
    prepared: args.prepared,
  })
  if (args.verified.breakdown !== undefined) extra.gradeBreakdown = args.verified.breakdown
  if (args.verified.passed) {
    const scoreEvidence: ReceiptEvidence = {
      officialHarnessResolved:
        args.instance.swebench !== undefined &&
        args.deps.pythonSwebench?.evaluate !== undefined &&
        args.graderInvalid === false,
      localExecutedGreen: true,
      researchKnobTouched: researchKnobTouched(args.prepared.posture),
    }
    extra.scoreEvidence = scoreEvidence
    extra.scoreLabel = labelForReceipt(scoreEvidence)
  }
  return extra
}

export const verifyAndFinalizeResult = async (args: {
  readonly instance: Instance
  readonly phase: Phase
  readonly deps: RunInstanceDeps
  readonly sandbox: string
  readonly signal: AbortSignal
  readonly reproTest: BenchReproTestTelemetry | undefined
  readonly wiring: Wiring
  readonly startedAt: number
  readonly prepared: PreparedAttemptContext
}): Promise<InstanceResult> => {
  const verified = await verify(args.instance, args.phase.patch, args.sandbox, {
    ...args.deps,
    signal: args.signal,
  })
  const validated = await validateVerifiedOutcome({
    instance: args.instance,
    deps: args.deps,
    signal: args.signal,
    verified,
  })
  const extra = buildSuccessfulResultExtra({
    ...args,
    verified: validated.verified,
    graderInvalid: validated.graderInvalid,
    goldResolved: validated.goldResolved,
  })
  return okResult(args.instance, args.phase, validated.verified, extra)
}
