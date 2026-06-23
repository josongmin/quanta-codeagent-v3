/**
 * Proof-state classification + eval-only telemetry projections for the selection
 * executor. Pure functions over already-scored entries. `summarizeSelection` is
 * re-exported from `./selection-executor` (public surface); the proof-state
 * predicates here are imported back by the executor + the gates module.
 */

import {
  type HardGateSignals,
  isValidResolvedKofN,
  type ResolvedKofNSignal,
  resolvedKofNPositive,
} from "@/agent/verification-bundle"
import { candidateFamilyCoverageMissing } from "./candidate-families"
import { diffTouchedSymbols } from "./diff-touched-symbols"
import type { MweProofReceipt } from "./mwe-proof"
import type {
  ReproConsensusProofReceipt,
  ReproConsensusProofState,
  ReproConsensusTrace,
} from "./repair/resolved-consensus"
import type {
  PublicRegressionProofReceipt,
  PublicRegressionProofState,
} from "./repo-regression-discovery-adapter"
import type {
  CandidateTelemetry,
  ScoredEntry,
  SelectionProofSource,
  SelectionProofState,
  SelectionProofSummary,
  SelectionResult,
  SelectionTelemetry,
} from "./selection-types"

export const hardResolvedRejected = (signal: ResolvedKofNSignal | null): boolean => {
  if (signal === null) return false
  return !isValidResolvedKofN(signal) || signal.votes < signal.k
}

type ResolvedKofNWithTrace = ResolvedKofNSignal & {
  readonly reproTrace?: ReproConsensusTrace
}

export const reproTraceOf = (signal: ResolvedKofNSignal | null): ReproConsensusTrace | undefined =>
  signal === null ? undefined : (signal as ResolvedKofNWithTrace).reproTrace

export const publicRegressionStateOf = (args: {
  readonly hard: HardGateSignals
  readonly receipt: PublicRegressionProofReceipt | undefined
}): PublicRegressionProofState | undefined => {
  if (args.receipt !== undefined) return args.receipt.state
  if (args.hard.regressionGreen === true) return "safety_green"
  if (args.hard.regressionGreen === false) return "candidate_red"
  return undefined
}

export const reproConsensusStateOf = (args: {
  readonly resolved: ResolvedKofNSignal | null
  readonly receipt: ReproConsensusProofReceipt | undefined
}): ReproConsensusProofState | undefined => {
  if (args.receipt !== undefined) return args.receipt.state
  if (resolvedKofNPositive(args.resolved)) return "base_red_candidate_green"
  if (hardResolvedRejected(args.resolved)) return "base_red_candidate_red"
  return undefined
}

export const positiveSubmitProofSource = (args: {
  readonly resolved: ResolvedKofNSignal | null
  readonly mweReceipt: MweProofReceipt | undefined
  readonly reproConsensusReceipt: ReproConsensusProofReceipt | undefined
}): SelectionProofSource => {
  if (args.mweReceipt?.state === "patched_green") return "mwe_public_issue"
  if (
    args.reproConsensusReceipt?.state === "base_red_candidate_green" ||
    resolvedKofNPositive(args.resolved)
  ) {
    return "repro_consensus"
  }
  return "none"
}

export const cleanExecutableProof = (
  resolved: ResolvedKofNSignal | null,
  mweReceipt: MweProofReceipt | undefined,
  reproConsensusReceipt: ReproConsensusProofReceipt | undefined,
): boolean => positiveSubmitProofSource({ resolved, mweReceipt, reproConsensusReceipt }) !== "none"

export const selectionProofState = (args: {
  readonly resolved: ResolvedKofNSignal | null
  readonly hard: HardGateSignals
  readonly mweReceipt: MweProofReceipt | undefined
  readonly publicRegressionReceipt: PublicRegressionProofReceipt | undefined
  readonly reproConsensusReceipt: ReproConsensusProofReceipt | undefined
}): SelectionProofState => {
  if (
    positiveSubmitProofSource({
      resolved: args.resolved,
      mweReceipt: args.mweReceipt,
      reproConsensusReceipt: args.reproConsensusReceipt,
    }) !== "none"
  ) {
    return "proof_positive"
  }
  if (
    args.mweReceipt?.state === "execution_failed" ||
    args.publicRegressionReceipt?.state === "execution_failed" ||
    args.reproConsensusReceipt?.state === "execution_failed"
  ) {
    return "infra_blocked"
  }
  if (
    args.mweReceipt?.state === "candidate_red" ||
    hardResolvedRejected(args.resolved) ||
    args.publicRegressionReceipt?.state === "candidate_red" ||
    args.reproConsensusReceipt?.state === "base_red_candidate_red"
  ) {
    return "candidate_red"
  }
  if (
    args.hard.regressionGreen === true ||
    args.publicRegressionReceipt?.state === "safety_green"
  ) {
    return "safety_only"
  }
  return "proof_missing"
}

export const selectionProofStateForEntry = (
  entry: Pick<ScoredEntry, "candidate" | "hard" | "resolvedKofN">,
): SelectionProofState =>
  selectionProofState({
    resolved: entry.resolvedKofN,
    hard: entry.hard,
    mweReceipt: entry.candidate.mweReceipt,
    publicRegressionReceipt: entry.candidate.publicRegressionReceipt,
    reproConsensusReceipt: entry.candidate.reproConsensusReceipt,
  })

export const hasContractOnlyEvidence = (entry: ScoredEntry): boolean =>
  entry.requiredContractsSatisfied > 0 || entry.contractsSatisfied > 0

const summarizeProof = (result: SelectionResult): SelectionProofSummary | undefined => {
  const winnerEntry =
    result.winner === null
      ? undefined
      : result.scored.find((entry) => entry.candidate.id === result.winner?.id)
  const focusEntry =
    winnerEntry ?? result.scored.find((entry) => entry.candidate.patch.trim() !== "")
  if (focusEntry === undefined) return undefined
  const proofState = selectionProofState({
    resolved: focusEntry.resolvedKofN,
    hard: focusEntry.hard,
    mweReceipt: focusEntry.candidate.mweReceipt,
    publicRegressionReceipt: focusEntry.candidate.publicRegressionReceipt,
    reproConsensusReceipt: focusEntry.candidate.reproConsensusReceipt,
  })
  const proofSource = positiveSubmitProofSource({
    resolved: focusEntry.resolvedKofN,
    mweReceipt: focusEntry.candidate.mweReceipt,
    reproConsensusReceipt: focusEntry.candidate.reproConsensusReceipt,
  })
  const submittedCandidateProof = winnerEntry !== undefined && proofSource !== "none"
  const contractOnlySubmitted =
    winnerEntry !== undefined && !submittedCandidateProof && hasContractOnlyEvidence(winnerEntry)
  const repairOnlyCandidates = result.scored.filter(
    (entry) =>
      entry.candidate.patch.trim() !== "" &&
      selectionProofStateForEntry(entry) !== "proof_positive" &&
      hasContractOnlyEvidence(entry),
  ).length
  return {
    proofState,
    proofSource,
    proofRequiredMissing: result.noWinnerReason === "proof_required_missing",
    contractOnlySubmitted,
    contractOnlyBlocked:
      result.winner === null &&
      result.noWinnerReason === "proof_required_missing" &&
      repairOnlyCandidates > 0,
    ...(focusEntry.candidate.mweReceipt !== undefined
      ? { publicMweState: focusEntry.candidate.mweReceipt.state }
      : {}),
    ...(() => {
      const state = publicRegressionStateOf({
        hard: focusEntry.hard,
        receipt: focusEntry.candidate.publicRegressionReceipt,
      })
      return state === undefined ? {} : { publicRegressionState: state }
    })(),
    ...(() => {
      const state = reproConsensusStateOf({
        resolved: focusEntry.resolvedKofN,
        receipt: focusEntry.candidate.reproConsensusReceipt,
      })
      return state === undefined ? {} : { reproConsensusState: state }
    })(),
    // B5 — surface the executed module-smoke (public issue-smoke) HARD-gate
    // RESULT for the focus candidate. `null` ⇒ no smoke source ran (FAIL-OPEN),
    // so the field is omitted; true/false project to the green/red result the
    // downstream `ownerTestResultReceipt` shows the model (command always
    // withheld, C3 fence).
    ...(focusEntry.hard.smokeGreen === null
      ? {}
      : {
          moduleSmokeState: (focusEntry.hard.smokeGreen ? "green" : "red") as "green" | "red",
        }),
    repairOnlyCandidates,
    submittedCandidateProof,
  }
}

const selectionCandidateTelemetryOf = (s: ScoredEntry): CandidateTelemetry => {
  const publicRegression =
    s.candidate.publicRegressionReceipt?.state ??
    publicRegressionStateOf({ hard: s.hard, receipt: undefined })
  const reproConsensus =
    s.candidate.reproConsensusReceipt?.state ??
    reproConsensusStateOf({ resolved: s.resolvedKofN, receipt: undefined })
  const familyCoverage =
    s.candidate.familyId === undefined
      ? []
      : candidateFamilyCoverageMissing(
          {
            familyId: s.candidate.familyId,
            ownerFiles: s.candidate.familyOwnerFiles ?? [],
          },
          s.candidate.files,
        )
  return {
    id: s.candidate.id,
    files: s.candidate.files,
    ...(s.candidate.patch.trim() !== ""
      ? { touchedSymbols: diffTouchedSymbols(s.candidate.patch) }
      : {}),
    admissible: s.verdict.admissible,
    score: s.verdict.score,
    reasons: s.verdict.reasons,
    ...(s.candidate.familyId !== undefined ? { familyId: s.candidate.familyId } : {}),
    ...(s.candidate.familyReason !== undefined ? { familyReason: s.candidate.familyReason } : {}),
    ...(s.candidate.familyOwnerFiles !== undefined
      ? { familyOwnerFiles: s.candidate.familyOwnerFiles }
      : {}),
    ...(familyCoverage.length === 0 ? {} : { familyCoverageMissing: familyCoverage }),
    requiredContractsSatisfied: s.requiredContractsSatisfied,
    contractsSatisfied: s.contractsSatisfied,
    ...(s.candidate.mweReceipt !== undefined ? { mwe: s.candidate.mweReceipt.state } : {}),
    ...(publicRegression !== undefined ? { publicRegression } : {}),
    ...(reproConsensus !== undefined ? { reproConsensus } : {}),
    proofState: selectionProofStateForEntry(s),
    proofSource: positiveSubmitProofSource({
      resolved: s.resolvedKofN,
      mweReceipt: s.candidate.mweReceipt,
      reproConsensusReceipt: s.candidate.reproConsensusReceipt,
    }),
  }
}

/** Project a {@link SelectionResult} into compact eval-only telemetry (drops the
 *  full candidate patches; keeps files + verdict). Pure. */
export const summarizeSelection = (result: SelectionResult): SelectionTelemetry => {
  const proofSummary = summarizeProof(result)
  return {
    attempted: result.attempted,
    ownerFiles: result.ownerFiles,
    earlyAccepted: result.earlyAccepted,
    successfulGenerations: result.successfulGenerations,
    generationFailures: result.generationFailures,
    generated: result.generated,
    admissibleCount: result.admissibleCount,
    winnerId: result.winner?.id ?? null,
    ...(result.proofRequired ? { proofRequired: true } : {}),
    ...(result.noWinnerReason !== undefined ? { noWinnerReason: result.noWinnerReason } : {}),
    ...(result.winner?.familyId !== undefined ? { winningFamilyId: result.winner.familyId } : {}),
    ...(result.riskGate !== undefined ? { riskGate: result.riskGate } : {}),
    ...(result.counterfactual !== undefined ? { counterfactual: result.counterfactual } : {}),
    ...(result.repairFeedbackAttempts !== undefined
      ? { repairFeedbackAttempts: result.repairFeedbackAttempts }
      : {}),
    ...(result.repairFeedbackStopReason !== undefined
      ? { repairFeedbackStopReason: result.repairFeedbackStopReason }
      : {}),
    ...(proofSummary !== undefined ? { proofSummary } : {}),
    candidates: result.scored.map(selectionCandidateTelemetryOf),
  }
}
