import { evaluateSuccessPredicate, type PrimaryRailStep } from "@/agent/closure"
import { extractIssueHint } from "@/agent/issue-hint"
import type { IssueDeclaredExpected } from "@/agent/verification-plan"
import { resolveRepairEvaluatePredicate } from "@/runner/batch/eval/declared-expected-matcher"
import {
  type BenchKnobState,
  type BenchPosture,
  benchPostureFromState,
  buildRepairBreadthRunCandidates,
  buildReproVoteValidate,
  makeAcceptanceSelectCandidates,
  maybeReviewSubmission,
  type PreparedAttemptContext,
  repairLocalizePhaseSuppressed,
  resolveAcceptanceLlmRerank,
  resolveBenchKnobs,
  runRepairRoundsInSnapshot,
} from "@/runner/batch/eval/driver"
import type {
  LlmEvidenceArtifacts,
  VerificationTargetFact,
} from "@/runner/batch/eval/llm-evidence-packet"
import type { PerCandidateSeed } from "@/runner/batch/eval/location-set-fanout"
import type { Instance } from "../../types"
import { validate as defaultValidate } from "../repair/validator"
import type { Wiring } from "../report"
import { type Phase, repairForkRunner, runAgentOnce } from "./agent-phase"
import type { RunInstanceDeps } from "./deps"

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
  /** jun-26 repair spec gate: PUBLIC issue-declared expected output (from the
   *  closure session). Only consumed when `QUANTA_BENCH_REPAIR_SPEC_GATE` is on AND
   *  a `primaryRailStep` is set; absent / knob-off ⇒ never read (byte-identical). */
  issueDeclaredExpected: IssueDeclaredExpected | undefined,
  postureOverride?: BenchPosture,
  stateOverride?: BenchKnobState,
  chaRepairTargets?: PreparedAttemptContext["chaRepairTargets"],
  /** Strategy #7 location-set fanout: per-candidate seed factory (built from the
   *  localizer's ranked files). Absent ⇒ breadth candidates share the base seed
   *  (byte-identical). */
  perCandidateSeed?: PerCandidateSeed,
): Promise<Phase> => {
  // jun-25 — suppress the localize-phase EDIT-BLOCK for repair rounds (mirrors
  // the runner-core driver). The fault is already localized in repair (patch
  // exists + failing gate named, seed = "revise the patch now"), so the Phase-1
  // edit-block is a straitjacket that re-fires every fresh repair session and
  // forces ~5 wasted re-localize turns. Resolve the EFFECTIVE posture (override
  // or the env-derived posture `runAgentOnce`→`buildConfig` would otherwise
  // compute) and strip `phase1Turns`; the advisory steer is preserved. INITIAL
  // generation is unchanged.
  const resolvedPosture =
    postureOverride ??
    benchPostureFromState(stateOverride ?? resolveBenchKnobs({ envVars: process.env }), process.env)
  const repairPosture = repairLocalizePhaseSuppressed(resolvedPosture)
  // B1/B3: thread the slice-resolving inputs into the classic-repair packet so
  // its owner evidence carries exact slices (paired with issue symbols) and it
  // names the active proof target — parity with the selector-repair sibling.
  const repairIssueSymbols = extractIssueHint(instance.problemStatement).symbols
  const repairLlmEvidence: Partial<LlmEvidenceArtifacts> = {}
  // #2 repro-vote: K-of-N RESOLVED majority gate when the knob is on AND a
  // reproducing set exists; else byte-identical `repair.validate ?? defaultValidate`.
  const validate = buildReproVoteValidate(
    instance,
    reproSources,
    repair.validate ?? defaultValidate,
    deps.reproArtifactRootPath,
  )
  // jun-26 repair spec gate / jun-28 strong-oracle (mirror of the runner-core
  // driver): when the issue declares a concrete PUBLIC expected output AND the
  // spec-gate OR strong-oracle knob is on, wrap the typed-predicate evaluator so an
  // exit-0 repair round whose output LACKS the declared expected reads as a
  // predicate `matched:false` (a FALSE GREEN that `isFalseGreen` / the strong-oracle
  // conjunction catch). NO-LEAK: `issueDeclaredExpected` is public-issue-text only.
  // Both knobs OFF ⇒ the raw evaluator (byte-identical); `undefined` expected ⇒
  // `buildSpecGateEvaluatePredicate` returns the identity wrapper.
  const repairEvaluatePredicate = resolveRepairEvaluatePredicate(
    repairPosture,
    issueDeclaredExpected,
    evaluateSuccessPredicate,
  )
  // jun-28 repair-loop BREADTH: when B>1, fan a repair round out to B forked
  // candidates and continue from the one the SAME validator turns green (else the
  // best validator signal). B=1 (default) ⇒ `runCandidates` is undefined ⇒ the
  // orchestrator takes the legacy single `runOnce`+`validate` path (byte-identical).
  // jun-28 repair-loop BREADTH via the SHARED `buildRepairBreadthRunCandidates`
  // (defined in the runner core driver, reused here): B>1 ⇒ fan a repair round
  // out to B forked candidates. The app does NOT thread `chaMultisiteSteer` into
  // the forked agent — that divergence lives in the injected `runAgentOnFork`.
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
    runAgentOnFork: repairForkRunner(
      instance,
      deps,
      signal,
      w,
      precomputedHint,
      reproHint,
      closureHint,
      repairPosture,
      stateOverride,
    ),
  })
  // jun-30 SOTA++ acceptance: dual-guard the repair chooser on BOTH the
  // reproducing set and the owner-near PUBLIC regression set that was confirmed
  // green on the base tree during preparation. Empty set ⇒ repro-only legacy.
  const acceptanceSelectCandidates = makeAcceptanceSelectCandidates(
    instance,
    reproSources,
    sandbox,
    deps.timeoutMs,
    repairPosture.acceptance,
    ownerNearRegressionSet,
    resolveAcceptanceLlmRerank(instance, deps.llm, signal),
    // ADR-0539 R3: record each per-round acceptance pick on the OBSERVE trajectory
    // (rides `recovery`, `reason:"acceptance_select"`; no-leak — tier/votes/counts
    // only, never the winning patch). `QUANTA_BENCH_ACCEPTANCE` OFF ⇒ the selector
    // is `undefined` ⇒ this closure never fires ⇒ byte-identical.
    (t) => {
      w.observer?.acceptanceSelection({
        tier: t.tier,
        votes: t.votes,
        candidateCount: t.candidateCount,
        llmOverrode: t.llmOverrode,
      })
    },
  )
  // Repair-round orchestration inside a git snapshot via the SHARED
  // `runRepairRoundsInSnapshot` (runner core, reused here). The app's per-round
  // agent run omits `chaMultisiteSteer` — that divergence lives in `runOnce`.
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
      ),
  })
  const capturedPatch = patch !== "" ? patch : out.patch
  const submissionReview = maybeReviewSubmission(capturedPatch)
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
  }
}
