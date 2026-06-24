/**
 * TD — verify-and-select FINALIZE phase (scoring → ranking → finalize).
 *
 * Extracted from {@link selection-executor} to keep that orchestrator under the
 * god-MODULE ratchet. This module owns the SCORING and SELECTION half: probing a
 * candidate through the injected verification ports, assembling hard/soft
 * signals, applying the clean-authority/proof gates, ranking (research +
 * lexicographic clean), the risk-gate / static-accept / early-accept tactics,
 * the selector-repair feedback append, and the terminal `finalize` builder.
 *
 * The generation/orchestration half (runSelection, candidate generation,
 * family-coverage repair, context building) stays in selection-executor and
 * calls back into the handful of functions exported here. The two modules form
 * an intentional ESM import cycle restricted to FUNCTION references — nothing is
 * invoked at module-init time, so there is no initialization hazard. The run
 * context / state / ports interfaces are owned by selection-executor and
 * imported here type-only (type-only imports never create a runtime cycle).
 */

import { analyzePatchBudget } from "@/agent/patch-budget"
import {
  type HardGateSignals,
  type ResolvedKofNSignal,
  type SoftScoreSignals,
  selectBest,
  selectBestEffort,
  selectLexicographic,
} from "@/agent/verification-bundle"
import {
  deriveCounterfactualContracts,
  evaluateCounterfactualContracts,
} from "./counterfactual-contract"
import { extractCandidateRiskFacts } from "./counterfactual-risk"
import { buildCounterfactualSeed } from "./counterfactual-seed"
import { diffTouchedSymbols } from "./diff-touched-symbols"
import {
  contractsSatisfiedCount,
  mergeSelectionContractBundles,
  requiredContractsSatisfiedCount,
} from "./public-contract-bundle"
import type { SelectionContractBundle } from "./public-contract-types"
import {
  type AppendSelectorRepairResult,
  type CounterfactualVerdictSet,
  type DedupedCandidates,
  type GeneratedCandidates,
  postprocessGeneratedCandidate,
  type RiskGateStep,
  type ScoredPorts,
  type SelectionRunContext,
  sanitizeCandidatePublicContracts,
} from "./selection-executor"
import {
  applyMweProofHardGate,
  applyProofRequiredHardGate,
  applyStaticSanityHardGate,
  bestEffortEligible,
  buildLexTiers,
  declaredExpectedMatchOf,
  earlyAcceptable,
  familyCoverageMissingHardReasons,
  minimalityOf,
  ownerCoverageOf,
  requireHardResolvedForEarlyAccept,
  scoreWithAuthority,
  staticSanityReasonsOf,
  strongerTerminalRepresentative,
  terminalAuthorityRank,
  voterQuorumOf,
} from "./selection-gates"
import { normalizePatch } from "./selection-paths"
import { selectionProofState, selectionProofStateForEntry } from "./selection-proof-telemetry"
import {
  buildOracleFailureRepairSeed,
  buildRepairPacketText,
  buildStaticSanityRepairSeed,
} from "./selection-repair-seed"
import type {
  Candidate,
  CounterfactualTelemetry,
  RepairFeedbackStopReason,
  ResolvedKofNMode,
  ScoredEntry,
  SelectionNoWinnerReason,
  SelectionResult,
  SelectionRiskGateDecision,
  SelectionRiskGateTelemetry,
} from "./selection-types"

const proofReceiptsFor = async (
  ctx: SelectionRunContext,
  candidate: Candidate,
): Promise<
  Pick<ScoredPorts, "mweReceipt" | "publicRegressionReceipt" | "reproConsensusReceipt">
> => ({
  // SCAFF-06: a selection-time MWE run (port) is authoritative; it overrides a
  // generation-set receipt. Absent port ⇒ keep the generation-set one (or none).
  mweReceipt: (await ctx.args.ports.mweProof?.(candidate)) ?? candidate.mweReceipt,
  publicRegressionReceipt:
    (await ctx.args.ports.publicRegressionProof?.(candidate)) ?? candidate.publicRegressionReceipt,
  reproConsensusReceipt:
    (await ctx.args.ports.reproConsensusProof?.(candidate)) ?? candidate.reproConsensusReceipt,
})

const hardSignalsFor = async (
  ctx: SelectionRunContext,
  candidate: Candidate,
  isEmpty: boolean,
  resolvedKofN: ResolvedKofNSignal | null,
  resolvedMode: ResolvedKofNMode,
): Promise<HardGateSignals> => ({
  baseValidatedRed: candidate.baseValidatedRed,
  patchProduced: !isEmpty,
  applyClean: isEmpty ? null : ((await ctx.args.ports.applyClean?.(candidate)) ?? null),
  regressionGreen: (await ctx.args.ports.regression?.(candidate)) ?? null,
  smokeGreen: (await ctx.args.ports.smoke?.(candidate)) ?? null,
  patchedResolvedKofN: resolvedMode === "hard" ? resolvedKofN : null,
})

const probeOne = async (ctx: SelectionRunContext, candidate: Candidate): Promise<ScoredPorts> => {
  const cached = ctx.state.portsMemo.get(candidate)
  if (cached !== undefined) return cached
  const isEmpty = candidate.patch.trim() === ""
  const size = Buffer.byteLength(candidate.patch, "utf8")
  const resolvedKofN = (await ctx.args.ports.resolvedKofN?.(candidate)) ?? null
  const resolvedMode = ctx.args.resolvedKofNMode ?? "hard"
  const probed: ScoredPorts = {
    isEmpty,
    size,
    resolvedKofN,
    resolvedMode,
    hard: await hardSignalsFor(ctx, candidate, isEmpty, resolvedKofN, resolvedMode),
    voterQuorum: voterQuorumOf(resolvedMode, resolvedKofN),
    // an empty no-patch earns NO owner-coverage credit (even if a caller hands
    // it stray `files`) — it is a non-fix, not a fix that "touches the owner".
    ownerCoverage: isEmpty ? null : ownerCoverageOf(candidate.files, ctx.args.owners),
    declaredExpectedMatch: await declaredExpectedMatchOf(candidate, isEmpty, ctx.args.ports),
    staticSanityReasons: await staticSanityReasonsOf(candidate, isEmpty, ctx.args.ports),
    ...(await proofReceiptsFor(ctx, candidate)),
  }
  ctx.state.portsMemo.set(candidate, probed)
  return probed
}

const effectiveContractBundleFor = (
  ctx: SelectionRunContext,
  candidate: Candidate,
): SelectionContractBundle =>
  mergeSelectionContractBundles(ctx.contractBundle, candidate.publicContracts) ?? ctx.contractBundle

const contractCandidateOf = (
  candidate: Candidate,
): {
  readonly touchedFiles: readonly string[]
  readonly touchedSymbols: readonly string[]
} => ({
  touchedFiles: candidate.files,
  touchedSymbols: diffTouchedSymbols(candidate.patch),
})

const candidateWithSelectionReceipts = (candidate: Candidate, probed: ScoredPorts): Candidate => {
  if (
    probed.mweReceipt === undefined &&
    probed.publicRegressionReceipt === undefined &&
    probed.reproConsensusReceipt === undefined
  ) {
    return candidate
  }
  return {
    ...candidate,
    ...(probed.mweReceipt !== undefined ? { mweReceipt: probed.mweReceipt } : {}),
    ...(probed.publicRegressionReceipt !== undefined
      ? { publicRegressionReceipt: probed.publicRegressionReceipt }
      : {}),
    ...(probed.reproConsensusReceipt !== undefined
      ? { reproConsensusReceipt: probed.reproConsensusReceipt }
      : {}),
  }
}

const scoreOne = async (
  ctx: SelectionRunContext,
  candidate: Candidate,
  minB: number,
  maxB: number,
): Promise<ScoredEntry> => {
  const probed = await probeOne(ctx, candidate)
  const sanitizedCandidate = sanitizeCandidatePublicContracts(ctx, candidate)
  const soft: SoftScoreSignals = {
    declaredExpectedMatch: probed.declaredExpectedMatch,
    rubricScore: null,
    voterQuorum: probed.voterQuorum,
    // smallest real diff ⇒ 1; all equal ⇒ 1; larger ⇒ lower; empty ⇒ null.
    // The ONLY signal that varies with the relative minimality window, so it is
    // recomputed cheaply (pure arithmetic) on each scoring pass.
    minimality: minimalityOf({ isEmpty: probed.isEmpty, size: probed.size, minB, maxB }),
    ownerCoverage: probed.ownerCoverage,
  }
  const scoredContracts = effectiveContractBundleFor(ctx, sanitizedCandidate)
  const contractCandidate = contractCandidateOf(sanitizedCandidate)
  const requiredContractsSatisfied = requiredContractsSatisfiedCount(
    scoredContracts,
    contractCandidate,
  )
  const contractsSatisfied = contractsSatisfiedCount(scoredContracts, contractCandidate)
  const baseVerdict = scoreWithAuthority(
    probed.hard,
    soft,
    probed.declaredExpectedMatch,
    ctx.mode,
    ctx.args.declaredExpectedAuthority === "public",
  )
  // T1 (jun-24): the clean-mode family-coverage veto is DEFAULT-OFF and opt-IN.
  // Prior measurement concluded it is NET-NEGATIVE over-demand (it rejects a
  // producer-only-correct fix from structural call-graph evidence without
  // data-flow proof the consumer breaks), so it only fires when explicitly
  // enabled via `familyCoverageVeto === true`. Undefined/false ⇒ OFF.
  const structuralHardReasons =
    ctx.mode === "clean" && ctx.args.familyCoverageVeto === true
      ? familyCoverageMissingHardReasons(sanitizedCandidate)
      : []
  const proofState = selectionProofState({
    resolved: probed.resolvedKofN,
    hard: probed.hard,
    mweReceipt: probed.mweReceipt,
    publicRegressionReceipt: probed.publicRegressionReceipt,
    reproConsensusReceipt: probed.reproConsensusReceipt,
  })
  const verdict = applyProofRequiredHardGate(
    applyMweProofHardGate(
      applyStaticSanityHardGate(baseVerdict, [
        ...probed.staticSanityReasons,
        ...structuralHardReasons,
      ]),
      ctx.mode,
      probed.mweReceipt,
    ),
    ctx.proofRequired,
    proofState,
  )
  return {
    candidate: candidateWithSelectionReceipts(sanitizedCandidate, probed),
    hard: probed.hard,
    resolvedKofN: probed.resolvedKofN,
    voterQuorum: probed.voterQuorum,
    verdict,
    requiredContractsSatisfied,
    contractsSatisfied,
  }
}

const selectorRepairSeedOf = (
  ctx: SelectionRunContext,
  result: SelectionResult,
): string | undefined =>
  buildStaticSanityRepairSeed({ scored: result.scored, winner: result.winner }) ??
  buildOracleFailureRepairSeed({
    scored: result.scored,
    proofRequired: ctx.proofRequired,
    ...(ctx.args.oracleFailureRepairSeed !== undefined
      ? { oracleFailureSeedText: ctx.args.oracleFailureRepairSeed }
      : {}),
  })

const stopForMissingSelectorRepairSeed = (
  ctx: SelectionRunContext,
): { readonly stopReason?: RepairFeedbackStopReason } =>
  ctx.proofRequired ? { stopReason: "missing_seed" } : {}

const selectorRepairPromptOf = (
  ctx: SelectionRunContext,
  result: SelectionResult,
  seed: string,
): string =>
  buildRepairPacketText({
    scored: result.scored,
    seed,
    winner: result.winner,
    problemStatement: ctx.args.problemStatement ?? "",
    contractBundle: ctx.contractBundle,
    ...(ctx.args.verificationTarget !== undefined
      ? { verificationTarget: ctx.args.verificationTarget }
      : {}),
    ...(ctx.args.repairReadSource !== undefined ? { readSource: ctx.args.repairReadSource } : {}),
    ...(ctx.args.repairIssueSymbols !== undefined
      ? { issueSymbols: ctx.args.repairIssueSymbols }
      : {}),
    ...(ctx.args.repairOwnerEvidence !== undefined
      ? { structuralOwnerEvidence: ctx.args.repairOwnerEvidence }
      : {}),
    ...(ctx.args.recordLlmEvidencePacket !== undefined
      ? { recordLlmEvidencePacket: ctx.args.recordLlmEvidencePacket }
      : {}),
  })

const tryAppendSelectorRepair = async (
  ctx: SelectionRunContext,
  rawCandidates: readonly Candidate[],
  prompt: string,
): Promise<AppendSelectorRepairResult> => {
  try {
    const repaired = await postprocessGeneratedCandidate(
      ctx,
      await ctx.args.ports.generate(rawCandidates.length, prompt),
      rawCandidates.length,
      prompt,
    )
    return repaired.patch.trim() === ""
      ? { rawCandidates, appended: false, stopReason: "empty_patch" }
      : { rawCandidates: [...rawCandidates, repaired], appended: true }
  } catch {
    return { rawCandidates, appended: false, stopReason: "generation_failed" }
  }
}

export const maybeAppendSelectorRepair = async (
  ctx: SelectionRunContext,
  rawCandidates: readonly Candidate[],
  result: SelectionResult,
  seenRepairPrompts: Set<string>,
): Promise<AppendSelectorRepairResult> => {
  if (ctx.mode !== "clean" || rawCandidates.length === 0) {
    return { rawCandidates, appended: false }
  }
  const seed = selectorRepairSeedOf(ctx, result)
  if (seed === undefined) {
    return { rawCandidates, appended: false, ...stopForMissingSelectorRepairSeed(ctx) }
  }
  const prompt = selectorRepairPromptOf(ctx, result, seed)
  if (seenRepairPrompts.has(prompt)) {
    return { rawCandidates, appended: false, stopReason: "duplicate_seed" }
  }
  seenRepairPrompts.add(prompt)
  return tryAppendSelectorRepair(ctx, rawCandidates, prompt)
}

export const withRepairFeedbackTelemetry = (
  result: SelectionResult,
  attempts: number,
  stopReason: RepairFeedbackStopReason | undefined,
): SelectionResult =>
  attempts === 0 && stopReason === undefined
    ? result
    : {
        ...result,
        repairFeedbackAttempts: attempts,
        ...(stopReason !== undefined ? { repairFeedbackStopReason: stopReason } : {}),
      }

export const hasProofPositiveWinner = (result: SelectionResult): boolean =>
  result.winner !== null &&
  result.scored.some(
    (entry) =>
      entry.candidate.id === result.winner?.id &&
      selectionProofStateForEntry(entry) === "proof_positive",
  )

export const maybeFinalizeEarlyAccept = async (
  ctx: SelectionRunContext,
  rawCandidates: readonly Candidate[],
  candidate: Candidate,
): Promise<SelectionResult | null> => {
  if (ctx.args.earlyAccept !== true) return null
  const size = Buffer.byteLength(candidate.patch, "utf8")
  const entry = await scoreOne(ctx, candidate, size, size)
  if (
    !earlyAcceptable(
      entry,
      ctx.args.owners,
      requireHardResolvedForEarlyAccept(ctx.args.ports, ctx.args.resolvedKofNMode),
      ctx.mode,
    )
  ) {
    return null
  }
  return finalize(ctx, rawCandidates, true)
}

const staticAcceptEntry = async (
  ctx: SelectionRunContext,
  candidate: Candidate,
): Promise<ScoredEntry> => {
  const sanitizedCandidate = sanitizeCandidatePublicContracts(ctx, candidate)
  const isEmpty = sanitizedCandidate.patch.trim() === ""
  const hard: HardGateSignals = {
    baseValidatedRed: sanitizedCandidate.baseValidatedRed,
    patchProduced: !isEmpty,
    applyClean: null,
    regressionGreen: null,
    smokeGreen: null,
    patchedResolvedKofN: null,
  }
  const soft: SoftScoreSignals = {
    declaredExpectedMatch: await declaredExpectedMatchOf(
      sanitizedCandidate,
      isEmpty,
      ctx.args.ports,
    ),
    rubricScore: null,
    voterQuorum: null,
    minimality: isEmpty ? null : 1,
    ownerCoverage: isEmpty ? null : ownerCoverageOf(sanitizedCandidate.files, ctx.args.owners),
  }
  const effectiveContracts = effectiveContractBundleFor(ctx, sanitizedCandidate)
  const contractCandidate = contractCandidateOf(sanitizedCandidate)
  return {
    candidate: sanitizedCandidate,
    hard,
    resolvedKofN: null,
    voterQuorum: null,
    verdict: scoreWithAuthority(
      hard,
      soft,
      soft.declaredExpectedMatch,
      ctx.mode,
      ctx.args.declaredExpectedAuthority === "public",
    ),
    requiredContractsSatisfied: requiredContractsSatisfiedCount(
      effectiveContracts,
      contractCandidate,
    ),
    contractsSatisfied: contractsSatisfiedCount(effectiveContracts, contractCandidate),
  }
}

const staticAcceptWinnerOf = (ctx: SelectionRunContext, entry: ScoredEntry): Candidate | null => {
  const ranked = [{ id: entry.candidate.id, verdict: entry.verdict }]
  const bestEffortRanked = bestEffortEligible(entry, ctx.mode) ? ranked : []
  const winnerId = selectBest(ranked) ?? selectBestEffort(bestEffortRanked)
  return winnerId === entry.candidate.id ? entry.candidate : null
}

const staticAccept = async (
  ctx: SelectionRunContext,
  rawCandidates: readonly Candidate[],
  candidate: Candidate,
  riskGate: SelectionRiskGateTelemetry,
): Promise<SelectionResult> => {
  const entry = await staticAcceptEntry(ctx, candidate)
  const winner = staticAcceptWinnerOf(ctx, entry)
  return {
    attempted: ctx.args.n,
    ownerFiles: [...ctx.args.owners],
    earlyAccepted: false,
    successfulGenerations: rawCandidates.length,
    generationFailures: ctx.state.generationFailures,
    winner,
    terminalCandidate: winner === null ? entry.candidate : null,
    scored: [entry],
    admissibleCount: entry.verdict.admissible ? 1 : 0,
    generated: 1,
    proofRequired: ctx.proofRequired,
    ...(ctx.proofRequired ? { noWinnerReason: "proof_required_missing" as const } : {}),
    riskGate,
  }
}

const dedupeCandidates = (rawCandidates: readonly Candidate[]): DedupedCandidates => {
  const seen = new Set<string>()
  const firstIdByPatchKey = new Map<string, string>()
  const terminalRepresentativeByFirstId = new Map<string, Candidate>()
  const candidates = rawCandidates.filter((candidate) => {
    const key = normalizePatch(candidate.patch)
    if (!seen.has(key)) {
      seen.add(key)
      firstIdByPatchKey.set(key, candidate.id)
      terminalRepresentativeByFirstId.set(candidate.id, candidate)
      return true
    }
    const firstId = firstIdByPatchKey.get(key)
    const representative =
      firstId === undefined ? undefined : terminalRepresentativeByFirstId.get(firstId)
    if (firstId !== undefined && representative !== undefined) {
      terminalRepresentativeByFirstId.set(
        firstId,
        strongerTerminalRepresentative(representative, candidate),
      )
    }
    return false
  })
  return { candidates, terminalRepresentativeByFirstId }
}

const realPatchSizeWindow = (
  candidates: readonly Candidate[],
): { readonly minB: number; readonly maxB: number } => {
  const realSizes = candidates
    .filter((candidate) => candidate.patch.trim() !== "")
    .map((candidate) => Buffer.byteLength(candidate.patch, "utf8"))
  return {
    minB: realSizes.length > 0 ? Math.min(...realSizes) : 0,
    maxB: realSizes.length > 0 ? Math.max(...realSizes) : 0,
  }
}

const scoreCandidates = async (
  ctx: SelectionRunContext,
  candidates: readonly Candidate[],
  minB: number,
  maxB: number,
): Promise<ScoredEntry[]> => {
  const scored: ScoredEntry[] = []
  for (const candidate of candidates) {
    scored.push(await scoreOne(ctx, candidate, minB, maxB))
  }
  return scored
}

const counterfactualVerdictSet = (
  ctx: SelectionRunContext,
  scored: readonly ScoredEntry[],
): CounterfactualVerdictSet => {
  const contracts =
    ctx.state.cand0Facts !== undefined ? deriveCounterfactualContracts(ctx.state.cand0Facts) : []
  const violated = new Set<string>()
  for (const entry of scored) {
    if (!ctx.state.counterfactualCandidateIds.has(entry.candidate.id)) continue
    const ev = evaluateCounterfactualContracts({
      contracts,
      verdict: analyzePatchBudget(entry.candidate.patch, {
        ownerFiles: [...ctx.args.owners],
        runtimeExpandingPolicy: "gate",
      }),
      emptyPatch: entry.candidate.patch.trim() === "",
      candidateFiles: entry.candidate.files,
      targetOwnerFile: ctx.state.counterfactualOwnerFile,
    })
    if (!ev.satisfied) violated.add(entry.candidate.id)
  }
  return { contracts, violated }
}

const rankedEntries = (
  scored: readonly ScoredEntry[],
  violatedCounterfactual: ReadonlySet<string>,
): { readonly id: string; readonly verdict: ScoredEntry["verdict"] }[] =>
  scored
    .filter((entry) => !violatedCounterfactual.has(entry.candidate.id))
    .map((entry) => ({ id: entry.candidate.id, verdict: entry.verdict }))

const bestEffortRankedEntries = (
  ctx: SelectionRunContext,
  scored: readonly ScoredEntry[],
  violatedCounterfactual: ReadonlySet<string>,
): { readonly id: string; readonly verdict: ScoredEntry["verdict"] }[] =>
  scored
    .filter(
      (entry) =>
        bestEffortEligible(entry, ctx.mode) && !violatedCounterfactual.has(entry.candidate.id),
    )
    .map((entry) => ({ id: entry.candidate.id, verdict: entry.verdict }))

const lexCandidateOf = (
  ctx: SelectionRunContext,
  orderOf: ReadonlyMap<string, number>,
  entry: ScoredEntry,
  admissible: boolean,
) => ({
  id: entry.candidate.id,
  admissible,
  tiers: buildLexTiers(
    entry,
    orderOf.get(entry.candidate.id) ?? 0,
    ctx.args.owners,
    ctx.contractBundle,
  ),
})

const lexCleanWinnerId = (
  ctx: SelectionRunContext,
  scored: readonly ScoredEntry[],
  violatedCounterfactual: ReadonlySet<string>,
): string | null => {
  // `order` (the final lexicographic tie-break) MUST be the STABLE absolute
  // index in `scored`, not a per-filter index — otherwise the same candidate
  // would carry a different tie-break in the primary vs the best-effort pass
  // and the winner could flip non-deterministically when all higher tiers tie.
  const orderOf = new Map(scored.map((entry, i) => [entry.candidate.id, i]))
  const eligible = scored.filter((entry) => !violatedCounterfactual.has(entry.candidate.id))
  const primary = selectLexicographic(
    eligible.map((entry) => lexCandidateOf(ctx, orderOf, entry, entry.verdict.admissible)),
  )
  if (primary !== null) return primary
  const effort = eligible.filter((entry) => bestEffortEligible(entry, ctx.mode))
  return selectLexicographic(effort.map((entry) => lexCandidateOf(ctx, orderOf, entry, true)))
}

const winnerIdOf = (
  ctx: SelectionRunContext,
  scored: readonly ScoredEntry[],
  violatedCounterfactual: ReadonlySet<string>,
): string | null =>
  ctx.mode === "clean"
    ? lexCleanWinnerId(ctx, scored, violatedCounterfactual)
    : (selectBest(rankedEntries(scored, violatedCounterfactual)) ??
      selectBestEffort(bestEffortRankedEntries(ctx, scored, violatedCounterfactual)))

const counterfactualTelemetryOf = (
  ctx: SelectionRunContext,
  scored: readonly ScoredEntry[],
  verdictSet: CounterfactualVerdictSet,
): CounterfactualTelemetry | undefined => {
  if (ctx.args.counterfactual !== true) return undefined
  const scoredIds = new Set(scored.map((entry) => entry.candidate.id))
  return {
    enabled: true,
    seedGenerated: ctx.state.counterfactualSeed !== undefined,
    contracts: verdictSet.contracts,
    candidateIds: [...ctx.state.counterfactualCandidateIds].filter((id) => scoredIds.has(id)),
    violatedCandidateIds: [...verdictSet.violated],
  }
}

const noWinnerReasonOf = (
  ctx: SelectionRunContext,
  scored: readonly ScoredEntry[],
  winner: Candidate | null,
): SelectionNoWinnerReason | undefined => {
  if (winner !== null) return undefined
  const nonEmpty = scored.filter((entry) => entry.candidate.patch.trim() !== "")
  if (ctx.proofRequired && nonEmpty.length > 0) {
    const proofStates = nonEmpty.map((entry) => selectionProofStateForEntry(entry))
    return proofStates.every((state) => state === "infra_blocked")
      ? "proof_infra_blocked"
      : "proof_required_missing"
  }
  return scored.length > 0 ? "no_submittable_candidate" : undefined
}

const terminalCandidateOf = (
  scored: readonly ScoredEntry[],
  terminalRepresentativeByFirstId: ReadonlyMap<string, Candidate>,
): Candidate | null => {
  if (scored.length === 0) return null
  const bestTerminalRank = scored.reduce(
    (best, entry) =>
      Math.max(
        best,
        terminalAuthorityRank(
          terminalRepresentativeByFirstId.get(entry.candidate.id) ?? entry.candidate,
        ),
      ),
    0,
  )
  const terminalPool = scored
    .filter(
      (entry) =>
        terminalAuthorityRank(
          terminalRepresentativeByFirstId.get(entry.candidate.id) ?? entry.candidate,
        ) === bestTerminalRank,
    )
    .map((entry) => ({ id: entry.candidate.id, verdict: entry.verdict }))
  const terminalId = selectBestEffort(terminalPool)
  const chosen = scored.find((entry) => entry.candidate.id === terminalId)?.candidate ?? null
  return chosen === null ? null : (terminalRepresentativeByFirstId.get(chosen.id) ?? chosen)
}

export const finalize = async (
  ctx: SelectionRunContext,
  rawCandidates: readonly Candidate[],
  earlyAccepted: boolean,
  riskGate?: SelectionRiskGateTelemetry,
): Promise<SelectionResult> => {
  const { candidates, terminalRepresentativeByFirstId } = dedupeCandidates(rawCandidates)
  const { minB, maxB } = realPatchSizeWindow(candidates)
  const scored = await scoreCandidates(ctx, candidates, minB, maxB)

  const counterfactualVerdicts = counterfactualVerdictSet(ctx, scored)
  const winnerId = winnerIdOf(ctx, scored, counterfactualVerdicts.violated)
  const winner = scored.find((entry) => entry.candidate.id === winnerId)?.candidate ?? null
  const noWinnerReason = noWinnerReasonOf(ctx, scored, winner)
  const counterfactual = counterfactualTelemetryOf(ctx, scored, counterfactualVerdicts)
  return {
    attempted: ctx.args.n,
    ownerFiles: [...ctx.args.owners],
    earlyAccepted,
    successfulGenerations: rawCandidates.length,
    generationFailures: ctx.state.generationFailures,
    winner,
    terminalCandidate:
      winner === null ? terminalCandidateOf(scored, terminalRepresentativeByFirstId) : null,
    scored,
    admissibleCount: scored.filter((entry) => entry.verdict.admissible).length,
    generated: candidates.length,
    proofRequired: ctx.proofRequired,
    ...(noWinnerReason !== undefined ? { noWinnerReason } : {}),
    ...(riskGate !== undefined ? { riskGate } : {}),
    ...(counterfactual !== undefined ? { counterfactual } : {}),
  }
}

const riskGateTelemetryOf = (
  candidate: Candidate,
  decision: SelectionRiskGateDecision,
): SelectionRiskGateTelemetry => ({
  candidateId: candidate.id,
  expanded: decision.expand,
  reasons: decision.reasons,
  ...(decision.shadow !== undefined
    ? {
        shadow: {
          expanded: decision.shadow.expand,
          reasons: decision.shadow.reasons,
        },
      }
    : {}),
})

const recordCounterfactualSeed = (
  ctx: SelectionRunContext,
  decision: SelectionRiskGateDecision,
  candidate: Candidate,
): void => {
  if (ctx.args.counterfactual !== true || decision.patchBudget === undefined) return
  const ownerFile = [...ctx.args.owners][0]
  if (ownerFile !== undefined) ctx.state.counterfactualOwnerFile = ownerFile
  ctx.state.cand0Facts = extractCandidateRiskFacts({
    verdict: decision.patchBudget,
    ownerFiles: [...ctx.args.owners],
    emptyPatch: candidate.patch.trim() === "",
    ...(decision.shadow !== undefined ? { llmShadowReasons: decision.shadow.reasons } : {}),
  })
  const counterfactualSeed = buildCounterfactualSeed({
    facts: ctx.state.cand0Facts,
    ownerFile,
  })
  if (counterfactualSeed !== undefined) ctx.state.counterfactualSeed = counterfactualSeed
}

const noExpandRiskGateResult = async (
  ctx: SelectionRunContext,
  raw: readonly Candidate[],
  candidate: Candidate,
  riskGateTelemetry: SelectionRiskGateTelemetry,
): Promise<SelectionResult> =>
  ctx.args.counterfactual === true || ctx.proofRequired || ctx.mode === "clean"
    ? finalize(ctx, raw, false, riskGateTelemetry)
    : staticAccept(ctx, raw, candidate, riskGateTelemetry)

export const handleRiskGateForCandidateZero = async (
  ctx: SelectionRunContext,
  raw: readonly Candidate[],
  candidate: Candidate,
  index: number,
): Promise<RiskGateStep> => {
  if (index !== 0 || ctx.args.riskGate === undefined) return { expanded: false }
  const decision = await ctx.args.riskGate(candidate)
  if (decision.llmEvidencePacket !== undefined) {
    ctx.args.recordLlmEvidencePacket?.(decision.llmEvidencePacket)
  }
  const telemetry = riskGateTelemetryOf(candidate, decision)
  if (!decision.expand) {
    return {
      expanded: false,
      telemetry,
      result: await noExpandRiskGateResult(ctx, raw, candidate, telemetry),
    }
  }
  recordCounterfactualSeed(ctx, decision, candidate)
  return { expanded: true, telemetry }
}

export const withRiskGateTelemetry = (
  result: SelectionResult,
  riskGateTelemetry: SelectionRiskGateTelemetry | undefined,
): SelectionResult =>
  riskGateTelemetry === undefined || result.riskGate !== undefined
    ? result
    : { ...result, riskGate: riskGateTelemetry }

export const generatedResult = (
  raw: Candidate[],
  result: SelectionResult,
  riskGateTelemetry: SelectionRiskGateTelemetry | undefined,
): GeneratedCandidates =>
  riskGateTelemetry === undefined ? { raw, result } : { raw, riskGateTelemetry, result }
