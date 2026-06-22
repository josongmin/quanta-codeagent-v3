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
  isValidResolvedKofN,
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
import {
  type LlmEvidencePacket,
  type VerificationTargetFact,
} from "./llm-evidence-packet"
import type { MweProofReceipt } from "./mwe-proof"
import {
  contractsSatisfiedCount,
  evaluateBundle,
  mergePublicContractBundles,
  requiredContractsSatisfiedCount,
} from "./public-contract-bundle"
import type { PublicContractBundle } from "./public-contract-types"
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
  cleanDriftRejected,
  cleanProofAuthorityMissing,
  cleanUnprovenMultiSourceDriftRisk,
  declaredExpectedMatchOf,
  earlyAcceptable,
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
import {
  hasContractOnlyEvidence,
  reproTraceOf,
  selectionProofState,
  selectionProofStateForEntry,
} from "./selection-proof-telemetry"
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

/**
 * Run the verify-and-select executor. Pure over the injected ports.
 *
 * `seeds[i]` is the localization focus for candidate i (`seeds[0]` is typically
 * `undefined` = an unbiased baseline). `owners` is the closure localization-
 * ranked file set used for owner-coverage.
 */
export const runSelection = async (args: {
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
  /** OPC-07 runtime packet recorder. Stores which bounded packet stages were
   *  actually used on the live clean path without changing selector authority. */
  recordLlmEvidencePacket?: (packet: LlmEvidencePacket) => void
}): Promise<SelectionResult> => {
  // ── generate ──────────────────────────────────────────────────────────────
  // Results are collected in INDEX order regardless of completion timing, so
  // dedup ("first wins") and scoring stay deterministic.
  const mode: SelectorMode = args.mode ?? "research"
  const proofRequired = mode === "clean" && args.proofRequired === true
  // Clean contract-dominance tier is fed ONLY by genuinely-sourced public
  // contracts the caller supplies (T-CON-10: public issue text / public tests /
  // validated repros / AUTHORITATIVE static-witness owners). We intentionally do
  // NOT auto-derive an owner-must-touch contract from the closure owner list:
  // those owners come from the additive heuristic score ranking (ISSUE_FILE_BOOST
  // etc.), so promoting them into a `required` dominance tier would smuggle the
  // very heuristic authority this clean path removes back in via a mislabeled
  // contract. Until T-OWN-12 distinguishes authoritative (LSP-definition) owners
  // from advisory (scored) ones, the tier stays empty unless explicitly fed.
  const contractBundle: PublicContractBundle = args.publicContracts ?? { contracts: [] }
  const limit = Math.max(1, Math.floor(args.concurrency ?? 1))
  if (args.counterfactual === true && limit > 1) {
    throw new Error("verify-select-counterfactual requires verify-select-concurrency=1")
  }
  let generationFailures = 0
  // ── counterfactual-select state (sequential arm only) ───────────────────────
  // Set after candidate 0's risk gate expands: cand0's deterministic risk facts,
  // the counterfactual seed derived from them, and the ids of candidates spawned
  // under that seed (so the selector can bar a contract-violating counterfactual
  // from winning WITHOUT touching the global candidate gate).
  let cand0Facts: CandidateRiskFacts | undefined
  let counterfactualOwnerFile: string | undefined
  let counterfactualSeed: string | undefined
  const counterfactualCandidateIds = new Set<string>()
  const withCandidatePublicContracts = (
    candidate: Candidate,
    publicContracts: PublicContractBundle | undefined,
  ): Candidate =>
    publicContracts === undefined
      ? candidate
      : {
          ...candidate,
          publicContracts:
            mergePublicContractBundles(candidate.publicContracts, publicContracts) ??
            publicContracts,
        }
  const withFamily = (candidate: Candidate, family: CandidateFamily): Candidate => ({
    ...candidate,
    familyId: family.familyId,
    familyReason: family.reason,
    familyOwnerFiles: family.ownerFiles,
  })
  const familyFromCandidate = (candidate: Candidate): CandidateFamily | undefined =>
    candidate.familyId === undefined || candidate.familyOwnerFiles === undefined
      ? undefined
      : {
          familyId: candidate.familyId,
          ownerFiles: candidate.familyOwnerFiles,
          reason: candidate.familyReason ?? `candidate-derived ${candidate.familyId} family`,
          seed: undefined,
          sourceEvidence: ["selection-candidate"],
        }
  const maybeRepairFamilyCoverage = async (
    candidate: Candidate,
    family: CandidateFamily,
    seed: string | undefined,
    index: number,
    publicContracts?: PublicContractBundle,
  ): Promise<Candidate> => {
    const candidateWithFamily = withFamily(
      withCandidatePublicContracts(candidate, publicContracts),
      family,
    )
    const missing = candidateFamilyCoverageMissing(family, candidate.files)
    if (missing.length === 0 || candidate.patch.trim() === "") return candidateWithFamily
    const repairSeed =
      `${seed ?? ""}\n\n${seedForCandidateFamilyCoverageRepair(family, missing)}`.trim()
    try {
      const repaired = await args.ports.generate(index, repairSeed)
      const repairedMissing = candidateFamilyCoverageMissing(family, repaired.files)
      return repaired.patch.trim() !== "" && repairedMissing.length < missing.length
        ? withFamily(withCandidatePublicContracts(repaired, publicContracts), family)
        : candidateWithFamily
    } catch {
      return candidateWithFamily
    }
  }
  const postprocessGeneratedCandidate = async (
    candidate: Candidate,
    index: number,
    seed: string | undefined,
    plannedFamily?: CandidateFamily,
  ): Promise<Candidate> => {
    if (plannedFamily !== undefined) {
      return maybeRepairFamilyCoverage(candidate, plannedFamily, seed, index)
    }
    const derived = await args.ports.deriveCandidateStructuralRepair?.(candidate)
    if (derived?.family !== undefined) {
      return maybeRepairFamilyCoverage(
        candidate,
        derived.family,
        seed,
        index,
        derived.publicContracts,
      )
    }
    return withCandidatePublicContracts(candidate, derived?.publicContracts)
  }
  const tryGenerate = async (i: number): Promise<Candidate | null> => {
    try {
      // The counterfactual seed replaces ONLY cand1 (the primary minimal
      // alternative). cand2+ keep their owner-focus seeds so the extra budget
      // still spans DIFFERENT fix sites — diversity, not N copies of one seed.
      const useCounterfactual = counterfactualSeed !== undefined && i === 1
      const seed = useCounterfactual ? counterfactualSeed : args.seeds[i]
      const candidate = await args.ports.generate(i, seed)
      if (useCounterfactual) counterfactualCandidateIds.add(candidate.id)
      const family = useCounterfactual ? undefined : args.candidateFamilies?.[i]
      return await postprocessGeneratedCandidate(candidate, i, seed, family)
    } catch {
      generationFailures += 1
      return null
    }
  }
  // Per-candidate memo of the EXPENSIVE, candidate-only port probes
  // (resolvedKofN / applyClean / regression / smoke — each a full tree reset +
  // pytest / repro consensus / public smoke probe). These depend ONLY on the
  // candidate, never on the relative `minB`/`maxB` minimality window, so with
  // `earlyAccept` on we run them ONCE per candidate (the early-gate probe) and
  // finalize reuses the verdict instead of re-materializing the tree a second
  // time. Keyed by candidate identity.
  interface ScoredPorts {
    isEmpty: boolean
    size: number
    resolvedKofN: ResolvedKofNSignal | null
    resolvedMode: ResolvedKofNMode
    hard: HardGateSignals
    voterQuorum: number | null
    ownerCoverage: number | null
    declaredExpectedMatch: boolean | null
    staticSanityReasons: readonly string[]
    /** SCAFF-06 selection-time MWE receipt (port-derived, else generation-set). */
    mweReceipt: MweProofReceipt | undefined
    publicRegressionReceipt: PublicRegressionProofReceipt | undefined
    reproConsensusReceipt: ReproConsensusProofReceipt | undefined
  }
  const portsMemo = new Map<Candidate, ScoredPorts>()
  const probeOne = async (c: Candidate): Promise<ScoredPorts> => {
    const cached = portsMemo.get(c)
    if (cached !== undefined) return cached
    const isEmpty = c.patch.trim() === ""
    const size = Buffer.byteLength(c.patch, "utf8")
    const resolvedKofN = (await args.ports.resolvedKofN?.(c)) ?? null
    const resolvedMode = args.resolvedKofNMode ?? "hard"
    const hard: HardGateSignals = {
      baseValidatedRed: c.baseValidatedRed,
      patchProduced: !isEmpty,
      applyClean: isEmpty ? null : ((await args.ports.applyClean?.(c)) ?? null),
      regressionGreen: (await args.ports.regression?.(c)) ?? null,
      smokeGreen: (await args.ports.smoke?.(c)) ?? null,
      patchedResolvedKofN: resolvedMode === "hard" ? resolvedKofN : null,
    }
    const probed: ScoredPorts = {
      isEmpty,
      size,
      resolvedKofN,
      resolvedMode,
      hard,
      voterQuorum: voterQuorumOf(resolvedMode, resolvedKofN),
      // an empty no-patch earns NO owner-coverage credit (even if a caller hands
      // it stray `files`) — it is a non-fix, not a fix that "touches the owner".
      ownerCoverage: isEmpty ? null : ownerCoverageOf(c.files, args.owners),
      declaredExpectedMatch: await declaredExpectedMatchOf(c, isEmpty, args.ports),
      staticSanityReasons: await staticSanityReasonsOf(c, isEmpty, args.ports),
      // SCAFF-06: a selection-time MWE run (port) is authoritative; it overrides a
      // generation-set receipt. Absent port ⇒ keep the generation-set one (or none).
      mweReceipt: (await args.ports.mweProof?.(c)) ?? c.mweReceipt,
      publicRegressionReceipt:
        (await args.ports.publicRegressionProof?.(c)) ?? c.publicRegressionReceipt,
      reproConsensusReceipt: (await args.ports.reproConsensusProof?.(c)) ?? c.reproConsensusReceipt,
    }
    portsMemo.set(c, probed)
    return probed
  }
  const scoreOne = async (c: Candidate, minB: number, maxB: number): Promise<ScoredEntry> => {
    const probed = await probeOne(c)
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
    const contractCandidate = {
      touchedFiles: c.files,
      touchedSymbols: diffTouchedSymbols(c.patch),
    }
    const effectiveContracts = mergePublicContractBundles(contractBundle, c.publicContracts)
    const scoredContracts = effectiveContracts ?? contractBundle
    const requiredContractsSatisfied = requiredContractsSatisfiedCount(
      scoredContracts,
      contractCandidate,
    )
    const contractsSatisfied = contractsSatisfiedCount(scoredContracts, contractCandidate)
    const baseVerdict = scoreWithAuthority(probed.hard, soft, probed.declaredExpectedMatch, mode)
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
          applyStaticSanityHardGate(baseVerdict, probed.staticSanityReasons),
          mode,
          probed.mweReceipt,
        ),
        cleanProofAuthorityMissing({
          mode,
          owners: args.owners,
          candidate: c,
          hard: probed.hard,
          resolved: probed.resolvedKofN,
          mweReceipt: probed.mweReceipt,
          reproConsensusReceipt: probed.reproConsensusReceipt,
          requiredContractsSatisfied,
          contractsSatisfied,
        }),
      ),
      proofRequired,
      proofState,
    )
    return {
      // SCAFF-06: carry the selection-time MWE receipt on the scored candidate so
      // the lexicographic top tier (buildLexTiers) sees it. Identity-preserving
      // when there is no receipt (byte-identical to the pre-SCAFF-06 path).
      candidate:
        probed.mweReceipt !== undefined ||
        probed.publicRegressionReceipt !== undefined ||
        probed.reproConsensusReceipt !== undefined
          ? {
              ...c,
              ...(probed.mweReceipt !== undefined ? { mweReceipt: probed.mweReceipt } : {}),
              ...(probed.publicRegressionReceipt !== undefined
                ? { publicRegressionReceipt: probed.publicRegressionReceipt }
                : {}),
              ...(probed.reproConsensusReceipt !== undefined
                ? { reproConsensusReceipt: probed.reproConsensusReceipt }
                : {}),
            }
          : c,
      hard: probed.hard,
      resolvedKofN: probed.resolvedKofN,
      voterQuorum: probed.voterQuorum,
      verdict,
      requiredContractsSatisfied,
      contractsSatisfied,
    }
  }

  const applySetLevelCleanDriftGate = (scored: ScoredEntry[]): void => {
    if (mode !== "clean") return
    // If any executable public-MWE receipt exists, the MWE tier is the stronger
    // authority. Do not let broad-drift protection overturn a candidate_red vs
    // no-receipt ordering; the drift gate is only for proofless sets.
    if (scored.some((s) => s.candidate.mweReceipt !== undefined)) return
    for (const entry of scored) {
      entry.verdict = applyCleanDriftHardGate(
        entry.verdict,
        cleanUnprovenMultiSourceDriftRisk({
          mode,
          candidate: entry.candidate,
          owners: args.owners,
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

  const maybeAppendSelectorRepair = async (
    rawCandidates: readonly Candidate[],
    result: SelectionResult,
  ): Promise<readonly Candidate[]> => {
    if (mode !== "clean" || rawCandidates.length === 0) return rawCandidates
    const seed =
      buildStaticSanityRepairSeed({ scored: result.scored, winner: result.winner }) ??
      buildOracleFailureRepairSeed({
        scored: result.scored,
        proofRequired,
        ...(args.oracleFailureRepairSeed !== undefined
          ? { oracleFailureSeedText: args.oracleFailureRepairSeed }
          : {}),
      })
    if (seed === undefined) return rawCandidates
    try {
      const prompt = buildRepairPacketText({
        scored: result.scored,
        seed,
        winner: result.winner,
        problemStatement: args.problemStatement ?? "",
        ...(contractBundle !== undefined ? { contractBundle } : {}),
        ...(args.verificationTarget !== undefined
          ? { verificationTarget: args.verificationTarget }
          : {}),
        ...(args.recordLlmEvidencePacket !== undefined
          ? { recordLlmEvidencePacket: args.recordLlmEvidencePacket }
          : {}),
      })
      const repaired = await postprocessGeneratedCandidate(
        await args.ports.generate(rawCandidates.length, prompt),
        rawCandidates.length,
        prompt,
      )
      return repaired.patch.trim() === "" ? rawCandidates : [...rawCandidates, repaired]
    } catch {
      return rawCandidates
    }
  }

  const maybeFinalizeEarlyAccept = async (
    rawCandidates: readonly Candidate[],
    candidate: Candidate,
  ): Promise<SelectionResult | null> => {
    if (args.earlyAccept !== true) return null
    const size = Buffer.byteLength(candidate.patch, "utf8")
    const entry = await scoreOne(candidate, size, size)
    return earlyAcceptable(
      entry,
      args.owners,
      requireHardResolvedForEarlyAccept(args.ports, args.resolvedKofNMode),
      mode,
    )
      ? await finalize(rawCandidates, true)
      : null
  }

  const staticAccept = async (
    rawCandidates: readonly Candidate[],
    candidate: Candidate,
    riskGate: SelectionRiskGateTelemetry,
  ): Promise<SelectionResult> => {
    const isEmpty = candidate.patch.trim() === ""
    const hard: HardGateSignals = {
      baseValidatedRed: candidate.baseValidatedRed,
      patchProduced: !isEmpty,
      applyClean: null,
      regressionGreen: null,
      smokeGreen: null,
      patchedResolvedKofN: null,
    }
    const soft: SoftScoreSignals = {
      declaredExpectedMatch: await declaredExpectedMatchOf(candidate, isEmpty, args.ports),
      rubricScore: null,
      voterQuorum: null,
      minimality: isEmpty ? null : 1,
      ownerCoverage: isEmpty ? null : ownerCoverageOf(candidate.files, args.owners),
    }
    const contractCandidate = {
      touchedFiles: candidate.files,
      touchedSymbols: diffTouchedSymbols(candidate.patch),
    }
    const effectiveContracts =
      mergePublicContractBundles(contractBundle, candidate.publicContracts) ?? contractBundle
    const entry = {
      candidate,
      hard,
      resolvedKofN: null,
      voterQuorum: null,
      verdict: scoreWithAuthority(hard, soft, soft.declaredExpectedMatch, mode),
      requiredContractsSatisfied: requiredContractsSatisfiedCount(
        effectiveContracts,
        contractCandidate,
      ),
      contractsSatisfied: contractsSatisfiedCount(effectiveContracts, contractCandidate),
    }
    const ranked = [{ id: candidate.id, verdict: entry.verdict }]
    const fallbackRanked = bestEffortEligible(entry, mode) ? ranked : []
    const winnerId = selectBest(ranked) ?? selectBestEffort(fallbackRanked)
    const winner = winnerId === candidate.id ? candidate : null
    return {
      attempted: args.n,
      ownerFiles: [...args.owners],
      earlyAccepted: false,
      successfulGenerations: rawCandidates.length,
      generationFailures,
      winner,
      terminalCandidate: winner === null ? candidate : null,
      scored: [entry],
      admissibleCount: entry.verdict.admissible ? 1 : 0,
      generated: 1,
      proofRequired,
      ...(proofRequired ? { noWinnerReason: "proof_required_missing" as const } : {}),
      riskGate,
    }
  }

  const finalize = async (
    rawCandidates: readonly Candidate[],
    earlyAccepted: boolean,
    riskGate?: SelectionRiskGateTelemetry,
  ): Promise<SelectionResult> => {
    // ── dedup by normalized diff (Trae's pruning lever) ──────────────────────
    const seen = new Set<string>()
    const firstIdByPatchKey = new Map<string, string>()
    const terminalRepresentativeByFirstId = new Map<string, Candidate>()
    const cands = rawCandidates.filter((c) => {
      const key = normalizePatch(c.patch)
      if (seen.has(key)) {
        const firstId = firstIdByPatchKey.get(key)
        if (firstId !== undefined) {
          const representative = terminalRepresentativeByFirstId.get(firstId)
          if (representative !== undefined) {
            terminalRepresentativeByFirstId.set(
              firstId,
              strongerTerminalRepresentative(representative, c),
            )
          }
        }
        return false
      }
      seen.add(key)
      firstIdByPatchKey.set(key, c.id)
      terminalRepresentativeByFirstId.set(c.id, c)
      return true
    })

    // ── relative minimality across the deduped set (parameter-free) ──────────
    // Computed over NON-EMPTY patches only: an empty diff is a non-fix, not a
    // "minimal" fix, so it gets NO minimality signal (null) — otherwise size 0
    // would score 1 and an empty no-patch could win best-effort over a real one.
    const realSizes = cands
      .filter((c) => c.patch.trim() !== "")
      .map((c) => Buffer.byteLength(c.patch, "utf8"))
    const minB = realSizes.length > 0 ? Math.min(...realSizes) : 0
    const maxB = realSizes.length > 0 ? Math.max(...realSizes) : 0

    const scored: ScoredEntry[] = []
    for (let i = 0; i < cands.length; i++) {
      scored.push(await scoreOne(cands[i] as Candidate, minB, maxB))
    }
    applySetLevelCleanDriftGate(scored)

    // ── counterfactual contract gate (T-301) ────────────────────────────────
    // A candidate spawned under the counterfactual seed that VIOLATES its own
    // derived structural contract is barred from WINNING over candidate 0. This
    // is a counterfactual-specific negative signal, NOT a global candidate gate:
    // candidates with no contract (cand0, or any non-counterfactual candidate)
    // are never excluded here, so a legitimately large patch still survives.
    const cfContracts = cand0Facts !== undefined ? deriveCounterfactualContracts(cand0Facts) : []
    const violatedCounterfactual = new Set<string>()
    if (cfContracts.length > 0) {
      for (const s of scored) {
        if (!counterfactualCandidateIds.has(s.candidate.id)) continue
        const ev = evaluateCounterfactualContracts({
          contracts: cfContracts,
          verdict: analyzePatchBudget(s.candidate.patch, {
            ownerFiles: [...args.owners],
            runtimeExpandingPolicy: "gate",
          }),
          emptyPatch: s.candidate.patch.trim() === "",
          candidateFiles: s.candidate.files,
          targetOwnerFile: counterfactualOwnerFile,
        })
        if (!ev.satisfied) violatedCounterfactual.add(s.candidate.id)
      }
    }
    const ranked = scored
      .filter((s) => !violatedCounterfactual.has(s.candidate.id))
      .map((s) => ({ id: s.candidate.id, verdict: s.verdict }))
    const fallbackRanked = scored
      .filter((s) => bestEffortEligible(s, mode) && !violatedCounterfactual.has(s.candidate.id))
      .map((s) => ({ id: s.candidate.id, verdict: s.verdict }))
    // ── clean: contract-first lexicographic selection (T-SEL-06) ─────────────
    // Executable proof dominates contracts dominates family dominates minimality;
    // no weighted sum can let a small symptom patch overturn a stronger-proof
    // root-cause patch. Research mode keeps the legacy weighted selectBest.
    const lexCleanWinner = (): string | null => {
      // `order` (the final lexicographic tie-break) MUST be the STABLE absolute
      // index in `scored`, not a per-filter index — otherwise the same candidate
      // would carry a different tie-break in the primary vs the best-effort pass
      // and the winner could flip non-deterministically when all higher tiers tie.
      const orderOf = new Map(scored.map((s, i) => [s.candidate.id, i]))
      const toLex = (s: ScoredEntry, admissible: boolean) => ({
        id: s.candidate.id,
        admissible,
        tiers: buildLexTiers(s, orderOf.get(s.candidate.id) ?? 0, args.owners, contractBundle),
      })
      const eligible = scored.filter((s) => !violatedCounterfactual.has(s.candidate.id))
      const primary = selectLexicographic(eligible.map((s) => toLex(s, s.verdict.admissible)))
      if (primary !== null) return primary
      // best-effort: structurally-submittable + executable-clean candidates only
      // (researchOnly smoke/declaredExpected carry NO clean veto), ranked lex.
      const effort = eligible.filter((s) => bestEffortEligible(s, mode))
      return selectLexicographic(effort.map((s) => toLex(s, true)))
    }
    const winnerId =
      mode === "clean" ? lexCleanWinner() : (selectBest(ranked) ?? selectBestEffort(fallbackRanked))
    // Report only counterfactual ids that SURVIVED dedup (are in `scored`): a
    // cand1 whose patch collapsed onto cand0 is gone from scoring, so listing it
    // would be a telemetry lie (and it carries no independent contract verdict).
    const scoredIds = new Set(scored.map((s) => s.candidate.id))
    const counterfactual: CounterfactualTelemetry | undefined =
      args.counterfactual === true
        ? {
            enabled: true,
            seedGenerated: counterfactualSeed !== undefined,
            contracts: cfContracts,
            candidateIds: [...counterfactualCandidateIds].filter((id) => scoredIds.has(id)),
            violatedCandidateIds: [...violatedCounterfactual],
          }
        : undefined
    const winner = scored.find((s) => s.candidate.id === winnerId)?.candidate ?? null
    let terminalCandidate: Candidate | null = null
    let noWinnerReason: SelectionNoWinnerReason | undefined
    if (winner === null) {
      const nonEmpty = scored.filter((entry) => entry.candidate.patch.trim() !== "")
      if (proofRequired && nonEmpty.length > 0) {
        const proofStates = nonEmpty.map((entry) => selectionProofStateForEntry(entry))
        noWinnerReason = proofStates.every((state) => state === "infra_blocked")
          ? "proof_infra_blocked"
          : "proof_required_missing"
      } else if (scored.length > 0) {
        noWinnerReason = "no_submittable_candidate"
      }
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
      const chosen = scored.find((s) => s.candidate.id === terminalId)?.candidate ?? null
      terminalCandidate =
        chosen === null ? null : (terminalRepresentativeByFirstId.get(chosen.id) ?? chosen)
    }
    return {
      attempted: args.n,
      ownerFiles: [...args.owners],
      earlyAccepted,
      successfulGenerations: rawCandidates.length,
      generationFailures,
      winner,
      terminalCandidate,
      scored,
      admissibleCount: scored.filter((s) => s.verdict.admissible).length,
      generated: cands.length,
      proofRequired,
      ...(noWinnerReason !== undefined ? { noWinnerReason } : {}),
      ...(riskGate !== undefined ? { riskGate } : {}),
      ...(counterfactual !== undefined ? { counterfactual } : {}),
    }
  }

  let raw: Candidate[]
  let riskGateTelemetry: SelectionRiskGateTelemetry | undefined
  if (limit <= 1) {
    // Sequential: each candidate is a full agent run sharing the sandbox; the
    // driver resets the tree between them. BYTE-IDENTICAL to the original loop.
    raw = []
    for (let i = 0; i < args.n; i++) {
      const candidate = await tryGenerate(i)
      if (candidate === null) continue
      raw.push(candidate)
      let riskGateExpanded = false
      if (i === 0 && args.riskGate !== undefined) {
        const decision = await args.riskGate(candidate)
        if (decision.llmEvidencePacket !== undefined) {
          args.recordLlmEvidencePacket?.(decision.llmEvidencePacket)
        }
        riskGateTelemetry = {
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
        }
        if (!decision.expand) {
          // T-101 + clean-gate closure (B#3): clean mode must NEVER blind-static-
          // accept. A no-expand cand0 still has to clear the real clean hard-gate
          // chain (staticSanity / clean-authority / drift / mwe) and probe the
          // wired ports via `finalize` — `staticAccept` hard-codes those ports to
          // null and would launder a deterministically-broken cand0 straight to
          // selection. Only the legacy/research arm keeps the cost-saving static
          // accept (byte-identical for non-clean modes). Validating cand0 through
          // finalize does NOT expand generation, so the cost rationale is intact.
          return args.counterfactual === true || proofRequired || mode === "clean"
            ? await finalize(raw, false, riskGateTelemetry)
            : await staticAccept(raw, candidate, riskGateTelemetry)
        }
        riskGateExpanded = true
        // T-202: derive cand0's risk facts and the counterfactual seed for cand1+.
        if (args.counterfactual === true && decision.patchBudget !== undefined) {
          counterfactualOwnerFile = [...args.owners][0]
          cand0Facts = extractCandidateRiskFacts({
            verdict: decision.patchBudget,
            ownerFiles: [...args.owners],
            emptyPatch: candidate.patch.trim() === "",
            ...(decision.shadow !== undefined ? { llmShadowReasons: decision.shadow.reasons } : {}),
          })
          counterfactualSeed = buildCounterfactualSeed({
            facts: cand0Facts,
            ownerFile: counterfactualOwnerFile,
          })
        }
      }
      if (riskGateExpanded) continue
      const earlyAccepted = await maybeFinalizeEarlyAccept(raw, candidate)
      if (earlyAccepted !== null) {
        if (riskGateTelemetry !== undefined) {
          return { ...earlyAccepted, riskGate: riskGateTelemetry }
        }
        return earlyAccepted
      }
    }
  } else {
    // Bounded-parallel: at most `limit` generate() calls in flight at once.
    const sem = new Semaphore(limit)
    const maybeRaw = await Promise.all(
      Array.from({ length: args.n }, async (_, i) => {
        const release = await sem.acquire()
        try {
          return await tryGenerate(i)
        } finally {
          release()
        }
      }),
    )
    raw = maybeRaw.filter((candidate): candidate is Candidate => candidate !== null)
  }
  let result = await finalize(raw, false, riskGateTelemetry)
  let repairedRaw = raw
  for (let repairRound = 0; repairRound < 1; repairRound++) {
    const nextRaw = await maybeAppendSelectorRepair(repairedRaw, result)
    if (nextRaw.length === repairedRaw.length) return result
    repairedRaw = [...nextRaw]
    result = await finalize(repairedRaw, false, riskGateTelemetry)
  }
  return result
}
