/**
 * TD — verify-and-select selection executor (pure orchestrator).
 *
 * The OUTER control plane: generate N candidate patches, score each through the
 * {@link VerificationBundle}, and return the winner. Bounded repair (if any)
 * lives INSIDE candidate generation as an inner tactic — it never holds global
 * verdict authority here. This module is a pure orchestrator over INJECTED
 * ports (generate / applyClean / regression / resolvedKofN): no fs, no exec,
 * no agent — so
 * it is fully unit-testable with fakes, and the driver supplies the real ports.
 *
 * Diversity, not repetition: `seeds[i]` nudges candidate i toward the i-th
 * ranked localization owner, so the set spans different FIX SITES (the measured
 * cause-vs-symptom failure is N samples of the same wrong anchor — diversity +
 * owner-coverage selection lets a sibling that touches the root-cause file win).
 *
 * Scoring signals assembled here:
 *   HARD  — baseValidatedRed (closure; `null` in no-oracle modes),
 *           patchProduced (empty diff = false), applyClean (non-empty diff can
 *           be probed via port), regressionGreen (port, null=fail-open),
 *           smokeGreen (port, null=fail-open), patchedResolvedKofN (port,
 *           null=fail-open), declaredExpected=false (selector-local public
 *           issue-shape contradiction).
 *   SOFT  — minimality (RELATIVE across the candidate set: smallest diff = 1,
 *           parameter-free), ownerCoverage (fraction of the candidate's files
 *           that are closure-ranked owners; null when no owner set),
 *           declaredExpected=true (optional public issue-shape ranking credit).
 *
 * Winner = `selectBest` (highest-scoring admissible) else a constrained
 * best-effort fallback. The fallback may preserve a candidate that merely lacks
 * provable-tier authority (for example `baseValidatedRed=false` after a post-edit
 * provider error), but it must NEVER resubmit a candidate that already has
 * explicit negative evidence such as `regressionGreen=false`,
 * `smokeGreen=false`, `patchedResolvedKofN votes<k`, an empty patch, or a known
 * non-applying diff.
 * The executor also preserves a `terminalCandidate` for stop-reason attribution.
 */

import { analyzePatchBudget } from "@/agent/patch-budget"
import {
  type HardGateSignals,
  type ResolvedKofNSignal,
  type SelectorMode,
  type SoftScoreSignals,
  selectBest,
  selectBestEffort,
  selectLexicographic,
} from "@/agent/verification-bundle"
import { Semaphore } from "@/workflow/semaphore"
import {
  type CandidateFamily,
  type CandidateFamilyBundle,
  candidateFamilyCoverageMissing,
  planFamilyCoverage,
  seedForCandidateFamily,
  seedForCandidateFamilyCoverageRepair,
} from "./candidate-families"
import {
  deriveCounterfactualContracts,
  evaluateCounterfactualContracts,
} from "./counterfactual-contract"
import { type CandidateRiskFacts, extractCandidateRiskFacts } from "./counterfactual-risk"
import { buildCounterfactualSeed } from "./counterfactual-seed"
import { diffTouchedSymbols } from "./diff-touched-symbols"
import type {
  LlmEvidencePacket,
  OwnerEvidenceFact,
  VerificationTargetFact,
} from "./llm-evidence-packet"
import type { MweProofReceipt } from "./mwe-proof"
import {
  contractsSatisfiedCount,
  mergePublicContractBundles,
  requiredContractsSatisfiedCount,
} from "./public-contract-bundle"
import { filterAuthorityContractBundle, type PublicContractBundle } from "./public-contract-types"
import type { ReproConsensusProofReceipt } from "./repair/resolved-consensus"
import type { PublicRegressionProofReceipt } from "./repo-regression-discovery-adapter"
import {
  applyCleanAuthorityHardGate,
  applyCleanDriftHardGate,
  applyMweProofHardGate,
  applyProofRequiredHardGate,
  applyStaticSanityHardGate,
  bestEffortEligible,
  buildLexTiers,
  cleanProofAuthorityMissing,
  cleanUnprovenMultiSourceDriftRisk,
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
import { normalizePatch, normalizeSelectionPaths } from "./selection-paths"
import { selectionProofState, selectionProofStateForEntry } from "./selection-proof-telemetry"
import {
  buildOracleFailureRepairSeed,
  buildRepairPacketText,
  buildStaticSanityRepairSeed,
} from "./selection-repair-seed"

export { ownerCoverageOf } from "./selection-gates"
// ── Re-exported public surface (moved to sibling modules, kept importable from
// `./selection-executor` byte-stable). ──────────────────────────────────────
export {
  filesFromPatch,
  normalizeSelectionPath,
  normalizeSelectionPaths,
} from "./selection-paths"
export { summarizeSelection } from "./selection-proof-telemetry"
export type {
  Candidate,
  CandidateTelemetry,
  CounterfactualTelemetry,
  DerivedCandidateStructuralRepair,
  FamilyCoverageRepairTelemetry,
  ResolvedKofNMode,
  ScoredEntry,
  SelectionNoWinnerReason,
  SelectionPorts,
  SelectionProofSource,
  SelectionProofState,
  SelectionProofSummary,
  SelectionResult,
  SelectionRiskGateDecision,
  SelectionRiskGateShadowDecision,
  SelectionRiskGateShadowTelemetry,
  SelectionRiskGateTelemetry,
  SelectionTelemetry,
} from "./selection-types"

// Type-only imports used by the kept `buildSelectionInputs` + `runSelection`
// orchestrator bodies.
import type {
  Candidate,
  CounterfactualTelemetry,
  FamilyCoverageRepairTelemetry,
  RepairFeedbackStopReason,
  ResolvedKofNMode,
  ScoredEntry,
  SelectionNoWinnerReason,
  SelectionPorts,
  SelectionResult,
  SelectionRiskGateDecision,
  SelectionRiskGateTelemetry,
} from "./selection-types"

export interface SelectionInputs {
  readonly ownerFiles: readonly string[]
  readonly owners: ReadonlySet<string>
  readonly seeds: readonly (string | undefined)[]
  readonly candidateFamilies: readonly (CandidateFamily | undefined)[]
}

export const buildSelectionInputs = (args: {
  readonly n: number
  readonly ownerCandidates: readonly string[]
  readonly sandbox?: string
  readonly candidateFamilies?: CandidateFamilyBundle
}): SelectionInputs => {
  const normalizedFamilyBundle =
    args.candidateFamilies === undefined
      ? undefined
      : {
          families: args.candidateFamilies.families.map((family) => ({
            ...family,
            ownerFiles: normalizeSelectionPaths(family.ownerFiles, args.sandbox),
          })),
        }
  const familySlotCount =
    normalizedFamilyBundle === undefined
      ? 0
      : Math.min(
          Math.max(0, args.n - 1),
          normalizedFamilyBundle.families.filter((family) => family.ownerFiles.length > 0).length,
        )
  const plannedFamilies = normalizedFamilyBundle
    ? planFamilyCoverage(normalizedFamilyBundle, familySlotCount)
    : []
  const plannedFamilyFor = (i: number): CandidateFamily | undefined =>
    i === 0 ? undefined : plannedFamilies[i - 1]
  const familyOwnerFiles = plannedFamilies.flatMap((family) => family.ownerFiles)
  const ownerFiles = normalizeSelectionPaths(
    [...args.ownerCandidates, ...familyOwnerFiles],
    args.sandbox,
  )
  const seedFor = (i: number): string | undefined => {
    if (i === 0) return undefined
    const plannedFamily = plannedFamilyFor(i)
    if (plannedFamily !== undefined) return seedForCandidateFamily(plannedFamily)
    const file = ownerFiles[i - 1]
    return file === undefined
      ? undefined
      : `Focus your investigation on \`${file}\`. Confirm the ROOT CAUSE lives there (not merely where the symptom surfaces) before editing.`
  }
  return {
    ownerFiles,
    owners: new Set(ownerFiles),
    seeds: Array.from({ length: args.n }, (_, i) => seedFor(i)),
    candidateFamilies: Array.from({ length: args.n }, (_, i) => plannedFamilyFor(i)),
  }
}

const sanitizeCleanAuthorityContractsForMode = (
  mode: SelectorMode,
  bundle: PublicContractBundle | undefined,
): PublicContractBundle | undefined => {
  if (bundle === undefined) return undefined
  if (mode !== "clean") return bundle
  return filterAuthorityContractBundle(bundle)
}

const sanitizeCandidatePublicContractsForMode = (
  mode: SelectorMode,
  candidate: Candidate,
): Candidate => {
  const publicContracts = sanitizeCleanAuthorityContractsForMode(mode, candidate.publicContracts)
  if (publicContracts === candidate.publicContracts) return candidate
  if (publicContracts === undefined) {
    const { publicContracts: _publicContracts, ...candidateWithoutPublicContracts } = candidate
    return candidateWithoutPublicContracts
  }
  return {
    ...candidate,
    publicContracts,
  }
}

export interface RunSelectionArgs {
  n: number
  seeds: readonly (string | undefined)[]
  owners: ReadonlySet<string>
  ports: SelectionPorts
  /** How to consume resolvedKofN. Default `hard` preserves legacy behavior.
   *  `soft` turns votes/k into positive ranking credit and never hard-rejects. */
  resolvedKofNMode?: ResolvedKofNMode
  /** Max candidates generated CONCURRENTLY. Default 1 = sequential (the shared-
   *  sandbox path — byte-identical to the pre-concurrency loop). >1 requires the
   *  `generate` port to ISOLATE each candidate (its own sandbox + deadline), or
   *  concurrent agent runs corrupt one shared git tree. Bounded by a Semaphore
   *  so total in-flight never exceeds this (the LLM-throttle ceiling guard). */
  concurrency?: number
  /** Progressive cost guard. Sequential-only: once a generated candidate is
   *  admissible, clean-applying, owner-scoped, and has the configured hard
   *  positive regression/resolved signal, submit it instead of burning the
   *  remaining candidate budget. Fail-open `null` gates and soft-only repro
   *  quorum remain ranking credit / keep-search signals, never global stop
   *  authority. Default false preserves N-best. */
  earlyAccept?: boolean
  /** Adaptive strict cost guard. Sequential-only: after candidate 0 exists, a
   *  pure static risk gate may accept it immediately without probing the
   *  expensive selection ports. If it expands, candidate 0 cannot be
   *  early-accepted; at least the next candidate is generated and the normal
   *  selector decides. */
  riskGate?: (
    candidate: Candidate,
  ) => SelectionRiskGateDecision | Promise<SelectionRiskGateDecision>
  /** Counterfactual-select arm. Sequential-only. When candidate 0 expands the
   *  risk gate, candidate 1+ is seeded with a COUNTERFACTUAL minimal-alternative
   *  prompt (the inverse of cand0's structural failure) instead of the generic
   *  owner-focus seed, and any counterfactual candidate that violates its own
   *  structural contract is barred from winning over candidate 0. When the gate
   *  does NOT expand, candidate 0 is accepted only after CHEAP validation (real
   *  applyClean / regression / smoke ports) instead of a blind static accept.
   *  Default/false preserves the legacy gated behavior byte-identically. */
  counterfactual?: boolean
  /** Selector authority mode (T-AUTH-01). `research` (default) preserves every
   *  legacy hard gate byte-identically. `clean` lets only executable/structural
   *  authority veto — researchOnly signals (issue smoke, declaredExpected,
   *  rubric) can neither reject nor rank. */
  mode?: SelectorMode
  /** OPTIONAL public-contract bundle (T-CON-10) for the clean lexicographic
   *  contract-dominance tier. When omitted, the contract tier stays empty.
   *  Ignored in research mode. */
  publicContracts?: PublicContractBundle
  /** Optional index-aligned family plan from typed static witness generation.
   *  Families steer exploration and clean lexicographic family rank only after
   *  the generated patch actually touches the family files. */
  candidateFamilies?: readonly (CandidateFamily | undefined)[]
  /** CLEAN-only, validated-public-oracle repair seed. This is not a heuristic:
   *  the executor appends one extra candidate only after every generated
   *  candidate has been executed against the relevant public oracle and none
   *  resolves it. Driver-supplied text may include base-red validated repro
   *  sources; absent keeps behavior byte-identical. */
  oracleFailureRepairSeed?: string
  /** v4 clean submit rail. When on, only positive executed public proof may
   *  submit; keep-green regression stays safety-only. */
  proofRequired?: boolean
  /** Public issue text — threaded so the post-exec repair_seed packet is
   *  self-contained (real issue facts) and carries the SAME opaque per-instance
   *  id as every other stage. Absent ⇒ neutral empty-issue fallback. */
  problemStatement?: string
  /** Blind-by-construction active proof target (repro steps only; see
   *  verificationTargetFromPlan). Surfaced in the repair_seed packet so the
   *  repair instruction names the public proof to satisfy. */
  verificationTarget?: VerificationTargetFact
  /** jun-23 W2-2 (B1) — sandbox source reader (rel ⇒ source | null) paired with
   *  {@link issueSymbols}, threaded into the SELECTOR repair packet so its owner
   *  evidence carries the EXACT symbol slice instead of a path-only stub. The
   *  path-only stub forced the adaptive router's `localizationCertain=false` in
   *  every selector-repair phase (A2). Reads PUBLIC source only — never a
   *  hidden-test path/command (the blindness invariant holds: it resolves owner
   *  files against the same source the generation stage already reads). Absent ⇒
   *  path-only (B2 surfaces the gap as `owner_slice` missingEvidence). */
  repairReadSource?: (rel: string) => string | null
  /** jun-23 W2-2 (B1) — PUBLIC issue symbols used (with {@link repairReadSource})
   *  to resolve the owner source slice in the selector repair packet. Blind:
   *  public issue text only. */
  repairIssueSymbols?: readonly string[]
  /** Candidate-generation owner evidence, including static-witness exact slices.
   *  Repair uses this as public source context only. It does not alter scoring,
   *  admissibility, or proof-required submit authority. */
  repairOwnerEvidence?: readonly OwnerEvidenceFact[]
  /** OPC-07 runtime packet recorder. Stores which bounded packet stages were
   *  actually used on the live clean path without changing selector authority. */
  recordLlmEvidencePacket?: (packet: LlmEvidencePacket) => void
}

interface ScoredPorts {
  readonly isEmpty: boolean
  readonly size: number
  readonly resolvedKofN: ResolvedKofNSignal | null
  readonly resolvedMode: ResolvedKofNMode
  readonly hard: HardGateSignals
  readonly voterQuorum: number | null
  readonly ownerCoverage: number | null
  readonly declaredExpectedMatch: boolean | null
  readonly staticSanityReasons: readonly string[]
  /** SCAFF-06 selection-time MWE receipt (port-derived, else generation-set). */
  readonly mweReceipt: MweProofReceipt | undefined
  readonly publicRegressionReceipt: PublicRegressionProofReceipt | undefined
  readonly reproConsensusReceipt: ReproConsensusProofReceipt | undefined
}

interface SelectionRunState {
  generationFailures: number
  cand0Facts?: CandidateRiskFacts
  counterfactualOwnerFile?: string
  counterfactualSeed?: string
  readonly counterfactualCandidateIds: Set<string>
  readonly portsMemo: Map<Candidate, ScoredPorts>
}

interface SelectionRunContext {
  readonly args: RunSelectionArgs
  readonly mode: SelectorMode
  readonly proofRequired: boolean
  readonly contractBundle: PublicContractBundle
  readonly limit: number
  readonly state: SelectionRunState
}

interface DedupedCandidates {
  readonly candidates: readonly Candidate[]
  readonly terminalRepresentativeByFirstId: Map<string, Candidate>
}

interface CounterfactualVerdictSet {
  readonly contracts: readonly string[]
  readonly violated: Set<string>
}

interface AppendSelectorRepairResult {
  readonly rawCandidates: readonly Candidate[]
  readonly appended: boolean
  readonly stopReason?: RepairFeedbackStopReason
}

interface GeneratedCandidates {
  readonly raw: Candidate[]
  readonly riskGateTelemetry?: SelectionRiskGateTelemetry
  readonly result?: SelectionResult
}

interface RiskGateStep {
  readonly expanded: boolean
  readonly telemetry?: SelectionRiskGateTelemetry
  readonly result?: SelectionResult
}

const buildSelectionRunContext = (args: RunSelectionArgs): SelectionRunContext => {
  const mode: SelectorMode = args.mode ?? "research"
  const limit = Math.max(1, Math.floor(args.concurrency ?? 1))
  if (args.counterfactual === true && limit > 1) {
    throw new Error("verify-select-counterfactual requires verify-select-concurrency=1")
  }
  return {
    args,
    mode,
    proofRequired: mode === "clean" && args.proofRequired === true,
    contractBundle: sanitizeCleanAuthorityContractsForMode(mode, args.publicContracts) ?? {
      contracts: [],
    },
    limit,
    state: {
      generationFailures: 0,
      counterfactualCandidateIds: new Set(),
      portsMemo: new Map(),
    },
  }
}

const sanitizeCandidatePublicContracts = (
  ctx: SelectionRunContext,
  candidate: Candidate,
): Candidate => sanitizeCandidatePublicContractsForMode(ctx.mode, candidate)

const withCandidateAdvisoryContracts = (
  candidate: Candidate,
  advisoryContracts: PublicContractBundle | undefined,
): Candidate =>
  advisoryContracts === undefined
    ? candidate
    : {
        ...candidate,
        advisoryContracts:
          mergePublicContractBundles(candidate.advisoryContracts, advisoryContracts) ??
          advisoryContracts,
      }

const withFamily = (candidate: Candidate, family: CandidateFamily): Candidate => ({
  ...candidate,
  familyId: family.familyId,
  familyReason: family.reason,
  familyOwnerFiles: family.ownerFiles,
})

const withFamilyCoverageRepairTelemetry = (
  candidate: Candidate,
  repair: FamilyCoverageRepairTelemetry,
): Candidate => ({
  ...candidate,
  familyCoverageRepair: repair,
})

const familyCoverageRepairSeed = (
  seed: string | undefined,
  family: CandidateFamily,
  missing: readonly string[],
): string => `${seed ?? ""}\n\n${seedForCandidateFamilyCoverageRepair(family, missing)}`.trim()

const shouldUseFamilyRepair = (
  candidate: Candidate,
  family: CandidateFamily,
): readonly string[] => {
  const missing = candidateFamilyCoverageMissing(family, candidate.files)
  return candidate.patch.trim() === "" ? [] : missing
}

const maybeRepairFamilyCoverage = async (
  ctx: SelectionRunContext,
  candidate: Candidate,
  family: CandidateFamily,
  seed: string | undefined,
  index: number,
  advisoryContracts?: PublicContractBundle,
): Promise<Candidate> => {
  const candidateWithFamily = withFamily(
    withCandidateAdvisoryContracts(candidate, advisoryContracts),
    family,
  )
  const missing = shouldUseFamilyRepair(candidate, family)
  if (missing.length === 0) return candidateWithFamily
  try {
    const repaired = await ctx.args.ports.generate(
      index,
      familyCoverageRepairSeed(seed, family, missing),
    )
    const repairedMissing = candidateFamilyCoverageMissing(family, repaired.files)
    if (repaired.patch.trim() === "") {
      return withFamilyCoverageRepairTelemetry(candidateWithFamily, {
        attempted: true,
        accepted: false,
        reason: "empty_patch",
        missingBefore: missing,
        missingAfter: repairedMissing,
      })
    }
    if (repairedMissing.length >= missing.length) {
      return withFamilyCoverageRepairTelemetry(candidateWithFamily, {
        attempted: true,
        accepted: false,
        reason: "missing_not_reduced",
        missingBefore: missing,
        missingAfter: repairedMissing,
      })
    }
    return withFamilyCoverageRepairTelemetry(
      withFamily(withCandidateAdvisoryContracts(repaired, advisoryContracts), family),
      {
        attempted: true,
        accepted: true,
        reason: "missing_reduced",
        missingBefore: missing,
        missingAfter: repairedMissing,
      },
    )
  } catch {
    return withFamilyCoverageRepairTelemetry(candidateWithFamily, {
      attempted: true,
      accepted: false,
      reason: "generation_failed",
      missingBefore: missing,
    })
  }
}

const postprocessGeneratedCandidate = async (
  ctx: SelectionRunContext,
  candidate: Candidate,
  index: number,
  seed: string | undefined,
  plannedFamily?: CandidateFamily,
): Promise<Candidate> => {
  const sanitizedCandidate = sanitizeCandidatePublicContracts(ctx, candidate)
  if (plannedFamily !== undefined) {
    return maybeRepairFamilyCoverage(ctx, sanitizedCandidate, plannedFamily, seed, index)
  }
  const derived = await ctx.args.ports.deriveCandidateStructuralRepair?.(sanitizedCandidate)
  if (derived?.family === undefined) {
    return withCandidateAdvisoryContracts(sanitizedCandidate, derived?.advisoryContracts)
  }
  return maybeRepairFamilyCoverage(
    ctx,
    sanitizedCandidate,
    derived.family,
    seed,
    index,
    derived.advisoryContracts,
  )
}

const tryGenerateCandidate = async (
  ctx: SelectionRunContext,
  index: number,
): Promise<Candidate | null> => {
  try {
    // The counterfactual seed replaces ONLY cand1 (the primary minimal
    // alternative). cand2+ keep their owner-focus seeds so the extra budget
    // still spans DIFFERENT fix sites — diversity, not N copies of one seed.
    const useCounterfactual = ctx.state.counterfactualSeed !== undefined && index === 1
    const seed = useCounterfactual ? ctx.state.counterfactualSeed : ctx.args.seeds[index]
    const candidate = await ctx.args.ports.generate(index, seed)
    if (useCounterfactual) ctx.state.counterfactualCandidateIds.add(candidate.id)
    const family = useCounterfactual ? undefined : ctx.args.candidateFamilies?.[index]
    return await postprocessGeneratedCandidate(ctx, candidate, index, seed, family)
  } catch {
    ctx.state.generationFailures += 1
    return null
  }
}

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
): PublicContractBundle =>
  mergePublicContractBundles(ctx.contractBundle, candidate.publicContracts) ?? ctx.contractBundle

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
  const baseVerdict = scoreWithAuthority(probed.hard, soft, probed.declaredExpectedMatch, ctx.mode)
  const structuralHardReasons =
    ctx.mode === "clean" ? familyCoverageMissingHardReasons(sanitizedCandidate) : []
  const proofState = selectionProofState({
    resolved: probed.resolvedKofN,
    hard: probed.hard,
    mweReceipt: probed.mweReceipt,
    publicRegressionReceipt: probed.publicRegressionReceipt,
    reproConsensusReceipt: probed.reproConsensusReceipt,
  })
  const verdict = applyProofRequiredHardGate(
    applyCleanAuthorityHardGate(
      applyMweProofHardGate(
        applyStaticSanityHardGate(baseVerdict, [
          ...probed.staticSanityReasons,
          ...structuralHardReasons,
        ]),
        ctx.mode,
        probed.mweReceipt,
      ),
      cleanProofAuthorityMissing({
        mode: ctx.mode,
        owners: ctx.args.owners,
        candidate: sanitizedCandidate,
        hard: probed.hard,
        resolved: probed.resolvedKofN,
        mweReceipt: probed.mweReceipt,
        reproConsensusReceipt: probed.reproConsensusReceipt,
        requiredContractsSatisfied,
        contractsSatisfied,
      }),
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

const applySetLevelCleanDriftGate = (ctx: SelectionRunContext, scored: ScoredEntry[]): void => {
  if (ctx.mode !== "clean") return
  // If any executable public-MWE receipt exists, the MWE tier is the stronger
  // authority. Do not let broad-drift protection overturn a candidate_red vs
  // no-receipt ordering; the drift gate is only for proofless sets.
  if (scored.some((s) => s.candidate.mweReceipt !== undefined)) return
  for (const entry of scored) {
    entry.verdict = applyCleanDriftHardGate(
      entry.verdict,
      cleanUnprovenMultiSourceDriftRisk({
        mode: ctx.mode,
        candidate: entry.candidate,
        owners: ctx.args.owners,
        hard: entry.hard,
        resolved: entry.resolvedKofN,
        mweReceipt: entry.candidate.mweReceipt,
        reproConsensusReceipt: entry.candidate.reproConsensusReceipt,
        requiredContractsSatisfied: entry.requiredContractsSatisfied,
        contractsSatisfied: entry.contractsSatisfied,
      }),
    )
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

const maybeAppendSelectorRepair = async (
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

const withRepairFeedbackTelemetry = (
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

const hasProofPositiveWinner = (result: SelectionResult): boolean =>
  result.winner !== null &&
  result.scored.some(
    (entry) =>
      entry.candidate.id === result.winner?.id &&
      selectionProofStateForEntry(entry) === "proof_positive",
  )

const maybeFinalizeEarlyAccept = async (
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
    verdict: scoreWithAuthority(hard, soft, soft.declaredExpectedMatch, ctx.mode),
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

const finalize = async (
  ctx: SelectionRunContext,
  rawCandidates: readonly Candidate[],
  earlyAccepted: boolean,
  riskGate?: SelectionRiskGateTelemetry,
): Promise<SelectionResult> => {
  const { candidates, terminalRepresentativeByFirstId } = dedupeCandidates(rawCandidates)
  const { minB, maxB } = realPatchSizeWindow(candidates)
  const scored = await scoreCandidates(ctx, candidates, minB, maxB)
  applySetLevelCleanDriftGate(ctx, scored)

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

const handleRiskGateForCandidateZero = async (
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

const withRiskGateTelemetry = (
  result: SelectionResult,
  riskGateTelemetry: SelectionRiskGateTelemetry | undefined,
): SelectionResult =>
  riskGateTelemetry === undefined || result.riskGate !== undefined
    ? result
    : { ...result, riskGate: riskGateTelemetry }

const generatedResult = (
  raw: Candidate[],
  result: SelectionResult,
  riskGateTelemetry: SelectionRiskGateTelemetry | undefined,
): GeneratedCandidates =>
  riskGateTelemetry === undefined ? { raw, result } : { raw, riskGateTelemetry, result }

const runSequentialGeneration = async (ctx: SelectionRunContext): Promise<GeneratedCandidates> => {
  const raw: Candidate[] = []
  let riskGateTelemetry: SelectionRiskGateTelemetry | undefined
  for (let i = 0; i < ctx.args.n; i++) {
    const candidate = await tryGenerateCandidate(ctx, i)
    if (candidate === null) continue
    raw.push(candidate)
    const riskGateStep = await handleRiskGateForCandidateZero(ctx, raw, candidate, i)
    if (riskGateStep.telemetry !== undefined) riskGateTelemetry = riskGateStep.telemetry
    if (riskGateStep.result !== undefined) {
      return generatedResult(raw, riskGateStep.result, riskGateTelemetry)
    }
    if (riskGateStep.expanded) continue
    const earlyAccepted = await maybeFinalizeEarlyAccept(ctx, raw, candidate)
    if (earlyAccepted !== null) {
      return generatedResult(
        raw,
        withRiskGateTelemetry(earlyAccepted, riskGateTelemetry),
        riskGateTelemetry,
      )
    }
  }
  return riskGateTelemetry === undefined ? { raw } : { raw, riskGateTelemetry }
}

const runParallelGeneration = async (ctx: SelectionRunContext): Promise<GeneratedCandidates> => {
  const sem = new Semaphore(ctx.limit)
  const maybeRaw = await Promise.all(
    Array.from({ length: ctx.args.n }, async (_, i) => {
      const release = await sem.acquire()
      try {
        return await tryGenerateCandidate(ctx, i)
      } finally {
        release()
      }
    }),
  )
  return { raw: maybeRaw.filter((candidate): candidate is Candidate => candidate !== null) }
}

const runRepairFeedbackLoop = async (
  ctx: SelectionRunContext,
  raw: readonly Candidate[],
  initialResult: SelectionResult,
  riskGateTelemetry: SelectionRiskGateTelemetry | undefined,
): Promise<SelectionResult> => {
  let result = initialResult
  let repairedRaw = raw
  let repairFeedbackAttempts = 0
  let repairFeedbackStopReason: RepairFeedbackStopReason | undefined
  const maxRepairFeedbackRounds = ctx.proofRequired ? 2 : 1
  const seenRepairPrompts = new Set<string>()
  for (let repairRound = 0; repairRound < maxRepairFeedbackRounds; repairRound++) {
    if (hasProofPositiveWinner(result)) {
      repairFeedbackStopReason =
        repairFeedbackAttempts > 0 ? "winner_found" : repairFeedbackStopReason
      break
    }
    const next = await maybeAppendSelectorRepair(ctx, repairedRaw, result, seenRepairPrompts)
    if (!next.appended) {
      repairFeedbackStopReason = next.stopReason
      break
    }
    repairFeedbackAttempts += 1
    repairedRaw = [...next.rawCandidates]
    result = await finalize(ctx, repairedRaw, false, riskGateTelemetry)
    if (hasProofPositiveWinner(result)) {
      repairFeedbackStopReason = "winner_found"
      break
    }
  }
  if (
    repairFeedbackAttempts >= maxRepairFeedbackRounds &&
    !hasProofPositiveWinner(result) &&
    repairFeedbackStopReason === undefined
  ) {
    repairFeedbackStopReason = "max_attempts"
  }
  return withRepairFeedbackTelemetry(result, repairFeedbackAttempts, repairFeedbackStopReason)
}

/**
 * Run the verify-and-select executor. Pure over the injected ports.
 *
 * `seeds[i]` is the localization focus for candidate i (`seeds[0]` is typically
 * `undefined` = an unbiased baseline). `owners` is the closure localization-
 * ranked file set used for owner-coverage.
 */
export const runSelection = async (args: RunSelectionArgs): Promise<SelectionResult> => {
  const ctx = buildSelectionRunContext(args)
  const generated =
    ctx.limit <= 1 ? await runSequentialGeneration(ctx) : await runParallelGeneration(ctx)
  if (generated.result !== undefined) return generated.result
  const result = await finalize(ctx, generated.raw, false, generated.riskGateTelemetry)
  return runRepairFeedbackLoop(ctx, generated.raw, result, generated.riskGateTelemetry)
}
