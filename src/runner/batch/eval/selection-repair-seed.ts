/**
 * Repair-seed helpers for the selection executor.
 *
 * This module owns BOTH layers of the selector's repair-follow-up path:
 *
 *   1. receipt→fact mappers: project typed proof receipts into the bounded LLM
 *      evidence packet shape;
 *   2. higher-level repair builders: derive structural/executable repair seeds
 *      and render the repair packet prompt from explicit inputs.
 *
 * Everything here is owner-local and explicit-input driven: no fs/exec/LLM, no
 * hidden benchmark surface, and no dependence on the executor's control flow
 * beyond the typed values it passes in.
 */

import { isValidResolvedKofN, type ResolvedKofNSignal } from "@/agent/verification-bundle"
import {
  type CandidateFamily,
  candidateFamilyCoverageMissing,
  seedForCandidateFamily,
  seedForCandidateFamilyCoverageRepair,
} from "./candidate-families"
import { diffTouchedSymbols } from "./diff-touched-symbols"
import {
  assembleOwnerEvidence,
  buildCandidatePostReviewLlmEvidencePacket,
  buildRepairSeedLlmEvidencePacket,
  type CandidateEditSurfaceFact,
  type ContractFact,
  candidatePatchHash,
  type LlmEvidencePacket,
  type OwnerEvidenceFact,
  type ProofReceiptFact,
  type ProofReceiptState,
  renderLlmEvidencePacket,
  type VerificationTargetFact,
} from "./llm-evidence-packet"
import { evaluateBundle, mergeSelectionContractBundles } from "./public-contract-bundle"
import { renderContractAuthorityLabel, type SelectionContractBundle } from "./public-contract-types"
import {
  hasContractOnlyEvidence,
  reproTraceOf,
  selectionProofStateForEntry,
} from "./selection-proof-telemetry"
import type { Candidate, ScoredEntry, SelectionProofState } from "./selection-types"

/** Tail-bound a string to its last `n` chars (repair-packet size guard). */
export const boundTail = (s: string | undefined, n = 1800): string => {
  const v = s ?? ""
  return v.length > n ? v.slice(-n) : v
}

/**
 * Join repair-seed sections: drop undefined/blank parts, then `\n\n`-join. For
 * all-string parts this is a byte-identical superset of `.filter((s) => s.trim()
 * !== "").join("\n\n")`.
 */
const joinSeedSections = (parts: readonly (string | undefined)[]): string =>
  parts.filter((s): s is string => s !== undefined && s.trim() !== "").join("\n\n")

const mweProofReceiptState = (
  state: NonNullable<Candidate["mweReceipt"]>["state"],
): ProofReceiptState => {
  switch (state) {
    case "base_red":
      return "base_red"
    case "base_not_red":
      return "base_green"
    case "patched_green":
      return "candidate_green"
    case "candidate_red":
      return "candidate_red"
    case "execution_failed":
      return "execution_failed"
    default:
      return "not_run"
  }
}

export const mweProofReceiptFacts = (candidate: Candidate): ProofReceiptFact[] => {
  const receipt = candidate.mweReceipt
  if (receipt === undefined) return []
  const patchHash = candidate.patch.trim() === "" ? undefined : candidatePatchHash(candidate.patch)
  return [
    {
      source: "public_mwe",
      state: mweProofReceiptState(receipt.state),
      ...(receipt.command !== undefined ? { command: receipt.command } : {}),
      ...(patchHash !== undefined ? { candidatePatchHash: patchHash } : {}),
    },
  ]
}

export const publicRegressionReceiptFacts = (candidate: Candidate): ProofReceiptFact[] => {
  const receipt = candidate.publicRegressionReceipt
  if (receipt === undefined) return []
  const patchHash = candidate.patch.trim() === "" ? undefined : candidatePatchHash(candidate.patch)
  const state: ProofReceiptState =
    receipt.state === "candidate_red"
      ? "candidate_red"
      : receipt.state === "safety_green"
        ? "candidate_green"
        : receipt.state === "execution_failed"
          ? "execution_failed"
          : "not_run"
  return [
    {
      source: "discovered_regression",
      state,
      ...(patchHash !== undefined ? { candidatePatchHash: patchHash } : {}),
    },
  ]
}

export const reproConsensusReceiptFacts = (candidate: Candidate): ProofReceiptFact[] => {
  const receipt = candidate.reproConsensusReceipt
  if (receipt === undefined) return []
  const patchHash = candidate.patch.trim() === "" ? undefined : candidatePatchHash(candidate.patch)
  const sample = receipt.reproTrace.samples.find((trace) => trace.outcome !== "resolved")
  const state: ProofReceiptState =
    receipt.state === "base_red_candidate_green"
      ? "candidate_green"
      : receipt.state === "base_red_candidate_red"
        ? "candidate_red"
        : receipt.state === "execution_failed"
          ? "execution_failed"
          : "not_run"
  return [
    {
      source: "repro_consensus",
      state,
      ...(receipt.state.startsWith("base_red") ? { baseValidatedRed: true } : {}),
      ...(sample?.stdoutTail !== undefined && sample.stdoutTail.trim() !== ""
        ? { stdoutTail: boundTail(sample.stdoutTail, 600) }
        : {}),
      ...(sample?.stderrTail !== undefined && sample.stderrTail.trim() !== ""
        ? { stderrTail: boundTail(sample.stderrTail, 600) }
        : {}),
      ...(patchHash !== undefined ? { candidatePatchHash: patchHash } : {}),
    },
  ]
}

/**
 * Hard-reason → proof-receipt state, keyed by the STRUCTURED `hard:<kind>=<value>`
 * KIND identifier (see selection-gates.ts reject-reason constants). Mapping from
 * the kind — not loose substring/`=false` matching — is what prevents a future
 * `hard:<x>=false` reject from being misclassified as `candidate_red`.
 */
const HARD_REASON_STATE: Record<string, ProofReceiptState> = {
  proofInfraBlocked: "execution_failed",
  proofRequiredMissing: "not_run",
  staticSanity: "static_only",
  mweProof: "candidate_red",
  declaredExpectedMatch: "candidate_red",
}

export const hardReasonState = (reason: string): ProofReceiptState => {
  const kind = /^hard:([A-Za-z]+)=/.exec(reason)?.[1]
  return (kind !== undefined ? HARD_REASON_STATE[kind] : undefined) ?? "not_run"
}

export interface SelectorRepairSeedPlan {
  readonly summary: string
  readonly directive: string
  readonly includeFamilyRepair: boolean
  readonly includeReproFailureTrace: boolean
  readonly includeOracleFailureSeed: boolean
}

const hasNonEmptyPatch = (entry: ScoredEntry): boolean => entry.candidate.patch.trim() !== ""

const candidateFamilyOf = (candidate: Candidate): CandidateFamily | undefined =>
  candidate.familyId === undefined || candidate.familyOwnerFiles === undefined
    ? undefined
    : {
        familyId: candidate.familyId,
        ownerFiles: candidate.familyOwnerFiles,
        reason: candidate.familyReason ?? `candidate-derived ${candidate.familyId} family`,
        seed: undefined,
        sourceEvidence: candidate.familySourceEvidence ?? ["selection-candidate"],
      }

const mweOracleRepairRequired = (scored: readonly ScoredEntry[]): boolean => {
  const patched = scored.filter(hasNonEmptyPatch)
  return (
    patched.length > 0 &&
    patched.some((s) => s.candidate.mweReceipt !== undefined) &&
    !patched.some((s) => s.candidate.mweReceipt?.state === "patched_green") &&
    patched.every((s) => s.candidate.mweReceipt?.state === "candidate_red")
  )
}

const unresolvedReproConsensus = (signal: ResolvedKofNSignal | null): boolean =>
  signal !== null && isValidResolvedKofN(signal) && signal.k > 0 && signal.votes < signal.k

const reproOracleRepairRequired = (
  scored: readonly ScoredEntry[],
  oracleFailureSeedText: string | undefined,
): boolean => {
  if (oracleFailureSeedText === undefined) return false
  const patched = scored.filter(hasNonEmptyPatch)
  return (
    patched.length > 0 &&
    patched.some((s) => s.resolvedKofN !== null) &&
    !patched.some(
      (s) =>
        s.resolvedKofN !== null &&
        isValidResolvedKofN(s.resolvedKofN) &&
        s.resolvedKofN.votes >= s.resolvedKofN.k,
    ) &&
    patched.every((s) => unresolvedReproConsensus(s.resolvedKofN))
  )
}

interface MissingFamilyRepairTarget {
  readonly family: CandidateFamily
  readonly missingFiles: readonly string[]
  readonly touchedFiles: readonly string[]
}

const bestMissingFamily = (
  scored: readonly ScoredEntry[],
): MissingFamilyRepairTarget | undefined => {
  const ranked = scored
    .map((entry, order) => ({
      family: candidateFamilyOf(entry.candidate),
      missing: candidateFamilyCoverageMissing(
        candidateFamilyOf(entry.candidate),
        entry.candidate.files,
      ),
      touchedFiles: entry.candidate.files,
      order,
    }))
    .filter(
      (
        entry,
      ): entry is {
        family: CandidateFamily
        missing: string[]
        touchedFiles: readonly string[]
        order: number
      } => entry.family !== undefined && entry.missing.length > 0,
    )
    .sort((a, b) => a.family.ownerFiles.length - b.family.ownerFiles.length || a.order - b.order)
  const best = ranked[0]
  return best === undefined
    ? undefined
    : { family: best.family, missingFiles: best.missing, touchedFiles: best.touchedFiles }
}

const familyRepairSeed = (scored: readonly ScoredEntry[]): string | undefined => {
  const target = bestMissingFamily(scored)
  if (target === undefined) return undefined
  const touchedFamilyFiles = target.touchedFiles.filter((file) =>
    target.family.ownerFiles.includes(file),
  )
  const touchedLine =
    touchedFamilyFiles.length === 0
      ? ""
      : ` Already-touched family files: ${touchedFamilyFiles.map((file) => `\`${file}\``).join(", ")}.`
  const missingLine = target.missingFiles.map((file) => `\`${file}\``).join(", ")
  return joinSeedSections([
    seedForCandidateFamilyCoverageRepair(target.family, target.missingFiles),
    `Bounded co-edit primitive:${touchedLine} Derive one equivalent edit pattern from the already-confirmed family site(s), then apply that same transformation across the remaining family owner files ${missingLine} in one repair step. Do not re-derive each sibling independently or widen beyond the named family.`,
  ])
}

const familyCoverageRepairRequired = (scored: readonly ScoredEntry[]): boolean =>
  scored.some(hasNonEmptyPatch) && bestMissingFamily(scored) !== undefined

const staticSanityReasons = (entry: ScoredEntry): readonly string[] =>
  entry.verdict.reasons.filter((reason) => reason.startsWith("hard:staticSanity="))

export const staticSanityInstruction = (reason: string): string =>
  `Static sanity failure: ${reason.replace("hard:staticSanity=", "")}. Regenerate from the base tree and remove this deterministic parse-level violation without dropping the stronger structural fix.`

export const buildStaticSanityRepairSeed = (args: {
  readonly scored: readonly ScoredEntry[]
  readonly winner: Candidate | null
}): string | undefined => {
  const { scored, winner } = args
  const winnerEntry =
    winner === null ? undefined : scored.find((entry) => entry.candidate.id === winner.id)
  const target = scored
    .filter((entry) => entry.candidate.patch.trim() !== "" && staticSanityReasons(entry).length > 0)
    .sort(
      (a, b) =>
        b.requiredContractsSatisfied - a.requiredContractsSatisfied ||
        b.contractsSatisfied - a.contractsSatisfied ||
        b.candidate.files.length - a.candidate.files.length,
    )[0]
  if (target === undefined) return undefined
  if (
    winnerEntry !== undefined &&
    target.requiredContractsSatisfied <= winnerEntry.requiredContractsSatisfied &&
    target.contractsSatisfied <= winnerEntry.contractsSatisfied
  ) {
    return undefined
  }
  const targetFamily = candidateFamilyOf(target.candidate)
  return joinSeedSections([
    "Selector feedback: a previous candidate reached stronger structural/public coverage, but it was rejected by deterministic static sanity checks.",
    ...(targetFamily === undefined ? [] : [seedForCandidateFamily(targetFamily)]),
    ...staticSanityReasons(target).map(staticSanityInstruction),
    "Regenerate from the base tree. Preserve the stronger structural coverage while removing the static sanity violation; do not retreat to a smaller partial patch unless the stronger coverage is disproven by public source evidence.",
  ])
}

export const buildReproFailureTraceSeed = (scored: readonly ScoredEntry[]): string | undefined => {
  const entry = scored.find((s) => {
    if (!unresolvedReproConsensus(s.resolvedKofN)) return false
    return reproTraceOf(s.resolvedKofN) !== undefined
  })
  if (entry === undefined || entry.resolvedKofN === null) return undefined
  const trace = reproTraceOf(entry.resolvedKofN)
  if (trace === undefined) return undefined
  const samples = trace.samples
    .filter((sample) => sample.outcome !== "resolved")
    .slice(0, 2)
    .map((sample, i) =>
      [
        `Patched repro sample ${i + 1}: outcome=${sample.outcome}`,
        sample.stdoutTail.trim() === ""
          ? "stdout tail: <empty>"
          : `stdout tail:\n${boundTail(sample.stdoutTail)}`,
        sample.stderrTail.trim() === ""
          ? "stderr tail: <empty>"
          : `stderr tail:\n${boundTail(sample.stderrTail)}`,
      ].join("\n"),
    )
  return [
    `Selector failure trace from ${entry.candidate.id}: votes=${entry.resolvedKofN.votes}, k=${entry.resolvedKofN.k}; vote=${trace.vote.verdict} (resolved=${trace.vote.resolved}, reproduced=${trace.vote.reproduced}, inconclusive=${trace.vote.inconclusive}).`,
    ...samples,
  ].join("\n\n")
}

/** Typed inputs the ordered repair-plan rule table evaluates against. */
export interface RepairPlanContext {
  readonly scored: readonly ScoredEntry[]
  readonly patched: readonly ScoredEntry[]
  readonly proofStates: readonly SelectionProofState[]
  readonly proofRequired: boolean
  readonly oracleFailureSeedText?: string
}

/**
 * Ordered, declarative repair-plan rule table. The first rule whose `when`
 * predicate holds wins (`.find` short-circuits exactly like the prior if-cascade
 * — predicates are pure, so this is identical first-match selection + laziness).
 * Order is load-bearing: infra-blocked → mweOracle → reproOracle → contract-only.
 * Summary/directive strings and the three include-flags are copied verbatim from
 * the original branches.
 */
const REPAIR_PLAN_RULES: readonly {
  when: (c: RepairPlanContext) => boolean
  plan: SelectorRepairSeedPlan
}[] = [
  {
    when: (c) =>
      c.proofRequired &&
      c.patched.length > 0 &&
      c.patched.some(
        (entry) =>
          entry.candidate.mweReceipt !== undefined ||
          entry.candidate.publicRegressionReceipt !== undefined ||
          entry.candidate.reproConsensusReceipt !== undefined,
      ) &&
      c.proofStates.every((state) => state === "infra_blocked"),
    plan: {
      summary:
        "Selector feedback: every generated candidate reached public proof execution, but each run failed in infra/runtime without producing a candidate-correctness verdict.",
      directive:
        "Regenerate from the base tree. Preserve the strongest structural/public coverage already found, but remove candidate-side execution blockers so the named public proof can actually run to completion. Do not widen scope or invent unrelated helpers.",
      includeFamilyRepair: true,
      includeReproFailureTrace: false,
      includeOracleFailureSeed: true,
    },
  },
  {
    when: (c) => mweOracleRepairRequired(c.scored),
    plan: {
      summary:
        "Selector feedback: every generated candidate was executed against a public issue MWE that reproduced on the base tree, and every candidate still failed that MWE.",
      directive:
        "Regenerate from the base tree. Treat the public MWE in the issue text as the executable contract: the patch must make that MWE pass without broadening the edit beyond the necessary source change.",
      includeFamilyRepair: true,
      includeReproFailureTrace: false,
      includeOracleFailureSeed: true,
    },
  },
  {
    when: (c) => reproOracleRepairRequired(c.scored, c.oracleFailureSeedText),
    plan: {
      summary:
        "Selector feedback: every generated candidate was re-run against the base-red validated reproduction set, and none reached resolved consensus.",
      directive:
        "Regenerate from the base tree. Treat the validated reproduction script(s) below as public executable contracts: the patch must make the scripts pass cleanly (all assertions green / exit 0) without adding unnecessary helpers, files, or unrelated design surface.",
      includeFamilyRepair: true,
      includeReproFailureTrace: true,
      includeOracleFailureSeed: true,
    },
  },
  {
    when: (c) =>
      c.proofRequired &&
      c.patched.length > 0 &&
      !c.proofStates.some((state) => state === "proof_positive") &&
      familyCoverageRepairRequired(c.scored),
    plan: {
      summary:
        "Selector feedback: at least one generated candidate selected a typed static family but edited only a partial family surface.",
      directive:
        "Regenerate from the base tree. Complete the missing family owner files named below if public source evidence confirms the family relation; otherwise produce no patch for that family rather than a partial single-site edit. The next candidate still must satisfy positive executed public proof before submit.",
      includeFamilyRepair: true,
      includeReproFailureTrace: true,
      includeOracleFailureSeed: true,
    },
  },
  {
    when: (c) =>
      c.proofRequired &&
      c.patched.length > 0 &&
      !c.proofStates.some((state) => state === "proof_positive") &&
      c.patched.some(hasContractOnlyEvidence),
    plan: {
      summary:
        "Selector feedback: at least one generated candidate achieved structural/public contract coverage, but no candidate produced positive executed public proof.",
      directive:
        "Regenerate from the base tree. Preserve the strongest structural/public coverage already found and make the named public proof run green. Do not broaden file scope, add unrelated helpers, or substitute structural guesses for executed proof.",
      includeFamilyRepair: true,
      includeReproFailureTrace: false,
      includeOracleFailureSeed: true,
    },
  },
]

/** First-match repair-plan selection over {@link REPAIR_PLAN_RULES}. */
export const selectRepairPlan = (c: RepairPlanContext): SelectorRepairSeedPlan | undefined =>
  REPAIR_PLAN_RULES.find((r) => r.when(c))?.plan

export const buildOracleFailureRepairSeed = (args: {
  readonly scored: readonly ScoredEntry[]
  readonly proofRequired: boolean
  readonly oracleFailureSeedText?: string
}): string | undefined => {
  const { scored, proofRequired, oracleFailureSeedText } = args
  const patched = scored.filter(hasNonEmptyPatch)
  const proofStates = patched.map((entry) => selectionProofStateForEntry(entry))
  const plan = selectRepairPlan({
    scored,
    patched,
    proofStates,
    proofRequired,
    ...(oracleFailureSeedText !== undefined ? { oracleFailureSeedText } : {}),
  })
  if (plan === undefined) return undefined
  return joinSeedSections([
    plan.summary,
    plan.directive,
    plan.includeFamilyRepair ? familyRepairSeed(scored) : undefined,
    plan.includeReproFailureTrace ? buildReproFailureTraceSeed(scored) : undefined,
    plan.includeOracleFailureSeed ? oracleFailureSeedText : undefined,
  ])
}

type BuildRepairPacketTextArgs = {
  readonly scored: readonly ScoredEntry[]
  readonly seed: string
  readonly winner: Candidate | null
  readonly contractBundle?: SelectionContractBundle
  readonly problemStatement: string
  readonly verificationTarget?: VerificationTargetFact
  /** B1: issue symbols used to resolve the EXACT owner source slice (paired with
   *  `readSource`). Blind — public issue text only. */
  readonly issueSymbols?: readonly string[]
  /** B1: sandbox source reader (rel ⇒ source | null). With `issueSymbols`, owner
   *  evidence carries the exact symbol slice instead of a path-only stub; absent
   *  ⇒ path-only (B2 surfaces the gap as `owner_slice` missingEvidence). */
  readonly readSource?: (rel: string) => string | null
  /** Candidate-generation owner evidence, including static-witness exact slices.
   *  Repair packets filter this to the current focus family/files and reuse it as
   *  public source context only; it never changes selector admission authority. */
  readonly structuralOwnerEvidence?: readonly OwnerEvidenceFact[]
  readonly recordLlmEvidencePacket?: (packet: LlmEvidencePacket) => void
}

const repairFocusCandidateOf = (
  scored: readonly ScoredEntry[],
  winner: Candidate | null,
): Candidate | undefined => {
  const latestNonEmpty = [...scored].reverse().find(hasNonEmptyPatch)?.candidate
  return (winner !== null && winner.patch.trim() !== "" ? winner : null) ?? latestNonEmpty
}

const repairProofReceiptsOf = (scored: readonly ScoredEntry[]): ProofReceiptFact[] => [
  ...scored.flatMap((entry) => [
    ...mweProofReceiptFacts(entry.candidate),
    ...publicRegressionReceiptFacts(entry.candidate),
    ...reproConsensusReceiptFacts(entry.candidate),
  ]),
  ...scored
    .flatMap((entry) =>
      entry.verdict.reasons.filter((reason) => reason.startsWith("hard:")).slice(0, 2),
    )
    .map((reason) => ({ source: reason, state: hardReasonState(reason) })),
]

const repairOwnerFilesOf = (
  scored: readonly ScoredEntry[],
  focusCandidate: Candidate | undefined,
): readonly string[] => [
  ...new Set(
    focusCandidate === undefined
      ? scored.flatMap((entry) => entry.candidate.familyOwnerFiles ?? entry.candidate.files)
      : (focusCandidate.familyOwnerFiles ?? focusCandidate.files),
  ),
]

const candidateEditSurfaceOf = (
  focusCandidate: Candidate | undefined,
): CandidateEditSurfaceFact | undefined =>
  focusCandidate === undefined || focusCandidate.patch.trim() === ""
    ? undefined
    : {
        touchedFiles: focusCandidate.files,
        touchedSymbols: diffTouchedSymbols(focusCandidate.patch),
      }

const repairContractsOf = (
  args: BuildRepairPacketTextArgs,
  focusCandidate: Candidate | undefined,
): ContractFact[] => {
  if (focusCandidate === undefined) return []
  const effectiveContracts = mergeSelectionContractBundles(
    mergeSelectionContractBundles(args.contractBundle, focusCandidate.publicContracts),
    focusCandidate.advisoryContracts,
  )
  if (effectiveContracts === undefined) return []
  const evaluations = new Map(
    evaluateBundle(effectiveContracts, {
      touchedFiles: focusCandidate.files,
      touchedSymbols: diffTouchedSymbols(focusCandidate.patch),
    }).map((evaluation) => [evaluation.contractId, evaluation]),
  )
  return effectiveContracts.contracts.map((contract) => ({
    contractId: contract.contractId,
    authority: renderContractAuthorityLabel(contract),
    satisfied: evaluations.get(contract.contractId)?.satisfied ?? "unknown",
  }))
}

export const buildRepairPacketText = (args: BuildRepairPacketTextArgs): string => {
  const focusCandidate = repairFocusCandidateOf(args.scored, args.winner)
  const patchAuthority = focusCandidate?.patch ?? args.scored[0]?.candidate.patch ?? args.seed
  const proofReceipts = repairProofReceiptsOf(args.scored)
  const ownerFiles = repairOwnerFilesOf(args.scored, focusCandidate)
  const ownerEvidence = repairOwnerEvidence({
    ownerFiles,
    ...(args.issueSymbols !== undefined ? { issueSymbols: args.issueSymbols } : {}),
    ...(args.readSource !== undefined ? { readSource: args.readSource } : {}),
    ...(args.structuralOwnerEvidence !== undefined
      ? { structuralOwnerEvidence: args.structuralOwnerEvidence }
      : {}),
  })
  // B7: the focus candidate's SOURCE-ONLY edit surface (touched files/symbols
  // from its OWN diff). Never a hidden-test path / command. Empty patch ⇒ none.
  const candidateEditSurface = candidateEditSurfaceOf(focusCandidate)
  const contracts = repairContractsOf(args, focusCandidate)
  const packet = buildRepairSeedLlmEvidencePacket({
    problemStatement: args.problemStatement,
    candidatePatchHash: candidatePatchHash(patchAuthority),
    ownerEvidence,
    proofReceipts,
    contracts,
    repairGuidance: args.seed,
    ...(args.verificationTarget !== undefined
      ? { verificationTarget: args.verificationTarget }
      : {}),
    ...(candidateEditSurface !== undefined ? { candidateEditSurface } : {}),
  })
  const reviewPacket = buildCandidatePostReviewLlmEvidencePacket({
    problemStatement: args.problemStatement,
    candidatePatchHash: candidatePatchHash(patchAuthority),
    ownerEvidence,
    proofReceipts,
    contracts,
    ...(args.verificationTarget !== undefined
      ? { verificationTarget: args.verificationTarget }
      : {}),
    ...(candidateEditSurface !== undefined ? { candidateEditSurface } : {}),
  })
  args.recordLlmEvidencePacket?.(reviewPacket)
  args.recordLlmEvidencePacket?.(packet)
  return `${renderLlmEvidencePacket(reviewPacket)}\n\n${renderLlmEvidencePacket(packet)}`
}

const dedupeOwnerEvidence = (facts: readonly OwnerEvidenceFact[]): OwnerEvidenceFact[] => {
  const byKey = new Map<string, OwnerEvidenceFact>()
  for (const fact of facts) {
    const key = JSON.stringify({
      file: fact.file,
      symbols: fact.symbols,
      provenance: fact.provenance,
      sourceSlice: fact.sourceSlice,
      sliceMiss: fact.sliceMiss,
      ambiguousSliceMatch: fact.ambiguousSliceMatch,
    })
    if (!byKey.has(key)) byKey.set(key, fact)
  }
  return [...byKey.values()]
}

const repairOwnerEvidence = (args: {
  readonly ownerFiles: readonly string[]
  readonly issueSymbols?: readonly string[]
  readonly readSource?: (rel: string) => string | null
  readonly structuralOwnerEvidence?: readonly OwnerEvidenceFact[]
}): OwnerEvidenceFact[] => {
  // B1: REUSE the slice-capable factory so a readable owner + issue symbols
  // attaches the EXACT symbol slice. Structural evidence from generation carries
  // static-witness slices for issue-symbol-empty cases; both are public source
  // context and neither changes selector admission authority.
  const direct = assembleOwnerEvidence({
    ownerFiles: args.ownerFiles,
    provenance: "repair-owner",
    ...(args.issueSymbols !== undefined ? { issueSymbols: args.issueSymbols } : {}),
    ...(args.readSource !== undefined ? { readSource: args.readSource } : {}),
  })
  const ownerFileSet = new Set(args.ownerFiles)
  const structural = (args.structuralOwnerEvidence ?? []).filter((fact) =>
    ownerFileSet.has(fact.file),
  )
  return dedupeOwnerEvidence([...direct, ...structural])
}
