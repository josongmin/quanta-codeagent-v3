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

import type { HardGateSignals, ResolvedKofNSignal, SelectorMode } from "@/agent/verification-bundle"
import { Semaphore } from "@/workflow/semaphore"
import {
  type CandidateFamily,
  type CandidateFamilyBundle,
  candidateFamilyCoverageMissing,
  planFamilyCoverage,
  seedForCandidateFamily,
  seedForCandidateFamilyCoverageRepair,
} from "./candidate-families"
import type { CandidateRiskFacts } from "./counterfactual-risk"
import type {
  LlmEvidencePacket,
  OwnerEvidenceFact,
  VerificationTargetFact,
} from "./llm-evidence-packet"
import type { MweProofReceipt } from "./mwe-proof"
import { mergeSelectionContractBundles } from "./public-contract-bundle"
import {
  filterAuthorityContractBundle,
  type SelectionContractBundle,
} from "./public-contract-types"
import type { ReproConsensusProofReceipt } from "./repair/resolved-consensus"
import type { PublicRegressionProofReceipt } from "./repo-regression-discovery-adapter"
import { normalizeSelectionPaths } from "./selection-paths"

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

// FINALIZE phase (scoring → ranking → finalize) lives in the sibling module.
// These are FUNCTION references only (called at runtime, never at module init),
// so the reciprocal import cycle with `./selection-finalize` is safe in ESM.
import {
  finalize,
  generatedResult,
  handleRiskGateForCandidateZero,
  hasProofPositiveWinner,
  maybeAppendSelectorRepair,
  maybeFinalizeEarlyAccept,
  withRepairFeedbackTelemetry,
  withRiskGateTelemetry,
} from "./selection-finalize"
// Type-only imports used by the kept `buildSelectionInputs` + `runSelection`
// orchestrator bodies.
import type {
  Candidate,
  FamilyCoverageRepairTelemetry,
  RepairFeedbackStopReason,
  ResolvedKofNMode,
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
      : `Among the candidate locations, pay particular attention to \`${file}\`: check whether the root cause lives there (rather than only where the symptom surfaces) before editing, and consider the other candidates too.`
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
  bundle: SelectionContractBundle | undefined,
): SelectionContractBundle | undefined => {
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
  /** T2b — authority of the wired `declaredExpected` port. `"public"` means the
   *  port was built from a PUBLIC-issue-text invariant
   *  (buildPublicDeclaredExpectedPort, which refuses any non-public source).
   *  NOTE: in CLEAN mode the declared-expected match is a STATIC, execution-free
   *  prose-regex compare and may only ever ADD ranking credit (the `true` case) —
   *  a `false` verdict NEVER hard-vetoes and never bars best-effort, even with
   *  `"public"` authority (a non-executed heuristic must not decide correctness).
   *  In RESEARCH mode the legacy answer-key veto on `false` is preserved
   *  byte-identically regardless of this flag. The flag is retained for call-site
   *  wiring / telemetry. */
  declaredExpectedAuthority?: "public" | "research"
  /** T1 (jun-24) clean-mode family-coverage veto (`hard:familyCoverageMissing`).
   *  DEFAULT-OFF, opt-IN. The producer-consumer witness drove this veto from
   *  structural call-graph evidence only (no data-flow proof that the consumer
   *  actually breaks), so a producer-only correct fix was over-demanded. Prior
   *  measurement concluded the veto is NET-NEGATIVE and it was reverted to opt-in:
   *  only `true` enables it; default/undefined/`false` ⇒ veto OFF. The
   *  relatedness/ranking credit (family rank tier, ownerCoverage) is unaffected. */
  familyCoverageVeto?: boolean
  /** OPTIONAL public-contract bundle (T-CON-10) for the clean lexicographic
   *  contract-dominance tier. When omitted, the contract tier stays empty.
   *  Ignored in research mode. */
  publicContracts?: SelectionContractBundle
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

export interface ScoredPorts {
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

export interface SelectionRunContext {
  readonly args: RunSelectionArgs
  readonly mode: SelectorMode
  readonly proofRequired: boolean
  readonly contractBundle: SelectionContractBundle
  readonly limit: number
  readonly state: SelectionRunState
}

export interface DedupedCandidates {
  readonly candidates: readonly Candidate[]
  readonly terminalRepresentativeByFirstId: Map<string, Candidate>
}

export interface CounterfactualVerdictSet {
  readonly contracts: readonly string[]
  readonly violated: Set<string>
}

export interface AppendSelectorRepairResult {
  readonly rawCandidates: readonly Candidate[]
  readonly appended: boolean
  readonly stopReason?: RepairFeedbackStopReason
}

export interface GeneratedCandidates {
  readonly raw: Candidate[]
  readonly riskGateTelemetry?: SelectionRiskGateTelemetry
  readonly result?: SelectionResult
}

export interface RiskGateStep {
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

export const sanitizeCandidatePublicContracts = (
  ctx: SelectionRunContext,
  candidate: Candidate,
): Candidate => sanitizeCandidatePublicContractsForMode(ctx.mode, candidate)

const withCandidateAdvisoryContracts = (
  candidate: Candidate,
  advisoryContracts: SelectionContractBundle | undefined,
): Candidate =>
  advisoryContracts === undefined
    ? candidate
    : {
        ...candidate,
        advisoryContracts:
          mergeSelectionContractBundles(candidate.advisoryContracts, advisoryContracts) ??
          advisoryContracts,
      }

const withFamily = (candidate: Candidate, family: CandidateFamily): Candidate => ({
  ...candidate,
  familyId: family.familyId,
  familyReason: family.reason,
  familyOwnerFiles: family.ownerFiles,
  familySourceEvidence: family.sourceEvidence,
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
  advisoryContracts?: SelectionContractBundle,
): Promise<Candidate> => {
  const candidateWithFamily = withFamily(
    withCandidateAdvisoryContracts(candidate, advisoryContracts),
    family,
  )
  const missing = shouldUseFamilyRepair(candidate, family)
  if (missing.length === 0) return candidateWithFamily
  const coedited = await ctx.args.ports
    .repairFamilyCoverage?.({
      candidate: candidateWithFamily,
      family,
      missingFiles: missing,
    })
    .catch(() => undefined)
  if (coedited !== undefined) {
    const coeditedMissing = candidateFamilyCoverageMissing(family, coedited.files)
    if (coedited.patch.trim() !== "" && coeditedMissing.length < missing.length) {
      return withFamilyCoverageRepairTelemetry(
        withFamily(withCandidateAdvisoryContracts(coedited, advisoryContracts), family),
        {
          attempted: true,
          accepted: true,
          reason: "missing_reduced",
          missingBefore: missing,
          missingAfter: coeditedMissing,
        },
      )
    }
  }
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

export const postprocessGeneratedCandidate = async (
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
