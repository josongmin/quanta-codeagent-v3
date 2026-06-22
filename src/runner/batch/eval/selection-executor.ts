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

import { isAbsolute, relative, sep } from "node:path"
import type { StopReason } from "@/agent"
import { analyzePatchBudget, type PatchBudgetVerdict } from "@/agent/patch-budget"
import {
  type CandidateVerdict,
  type HardGateSignals,
  isValidResolvedKofN,
  type LexTiers,
  type ResolvedKofNSignal,
  resolvedKofNPositive,
  resolvedKofNVoterQuorum,
  type SelectorMode,
  type SoftScoreSignals,
  scoreCandidate,
  selectBest,
  selectBestEffort,
  selectLexicographic,
} from "@/agent/verification-bundle"
import { filesFromUnifiedDiff } from "@/shared"
import { Semaphore } from "@/workflow/semaphore"
import {
  type CandidateFamily,
  type CandidateFamilyBundle,
  type CandidateFamilyId,
  candidateFamilyCoverageMissing,
  candidateFamilyRank,
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
  buildRepairSeedPacket,
  buildRepairSeedLlmEvidencePacket,
  candidatePatchHash,
  type ContractFact,
  type LlmEvidencePacket,
  type OwnerEvidenceFact,
  type ProofReceiptFact,
  type ProofReceiptState,
  type VerificationTargetFact,
  renderLlmEvidencePacket,
} from "./llm-evidence-packet"
import { type MweProofReceipt, type MweProofState, mweProofAuthorityRank } from "./mwe-proof"
import {
  contractsSatisfiedCount,
  evaluateBundle,
  mergePublicContractBundles,
  requiredContractsSatisfiedCount,
} from "./public-contract-bundle"
import type { PublicContractBundle } from "./public-contract-types"
import type { PublicRegressionProofReceipt, PublicRegressionProofState } from "./repo-regression-discovery-adapter"
import type {
  ReproConsensusProofReceipt,
  ReproConsensusProofState,
  ReproConsensusTrace,
} from "./repair/resolved-consensus"

export interface Candidate {
  /** Stable id (e.g. `cand-0`). */
  id: string
  /** The captured unified diff (empty string ⇒ no-patch). */
  patch: string
  /** Agent turns this candidate consumed (for cost bookkeeping). */
  turns: number
  /** Repo-relative files the diff touches (for owner-coverage). */
  files: readonly string[]
  /** The instance's repro-authority gate state (same for every candidate).
   *  `null` = selection mode does not require repro authority. */
  baseValidatedRed: boolean | null
  /** Terminal metadata preserved so upper drivers can classify no-winner
   *  outcomes from the best terminal candidate instead of flattening them to
   *  a generic empty-patch miss. */
  stopReason?: StopReason
  agentError?: string
  editCount?: number
  /** Candidate-family provenance supplied by typed static witness generation. */
  familyId?: CandidateFamilyId
  familyReason?: string
  familyOwnerFiles?: readonly string[]
  /** SCAFF-06 — executable PUBLIC-issue MWE proof receipt for this candidate.
   *  Drives the selector's top authority tier (`patched_green` admit /
   *  `candidate_red` veto; infra/absent = no authority). Absent until a real MWE
   *  execution feeds it ⇒ selection stays byte-identical. */
  mweReceipt?: MweProofReceipt
  /** Typed discovered public-regression receipt. Safety only: keep-green may
   *  reject regressions, but generic discovered tests do not prove the issue was
   *  fixed. */
  publicRegressionReceipt?: PublicRegressionProofReceipt
  /** Typed repro-consensus receipt. When positive, this is executed issue proof. */
  reproConsensusReceipt?: ReproConsensusProofReceipt
  /** OPTIONAL candidate-local public contracts discovered only after this
   *  patch exposed a typed structural witness. Merged with the global clean
   *  contract bundle for this candidate alone. */
  publicContracts?: PublicContractBundle
}

export interface DerivedCandidateStructuralRepair {
  readonly family?: CandidateFamily
  readonly publicContracts?: PublicContractBundle
}

export interface SelectionPorts {
  /** Generate candidate `index` with optional localization `seed`. */
  generate: (index: number, seed: string | undefined) => Promise<Candidate>
  /** OPTIONAL applyability hard signal; absent/null ⇒ non-empty patches fail open. */
  applyClean?: (c: Candidate) => Promise<boolean | null>
  /** OPTIONAL regression hard signal; absent ⇒ null (FAIL-OPEN). */
  regression?: (c: Candidate) => Promise<boolean | null>
  /** OPTIONAL public-smoke hard signal; absent ⇒ null (FAIL-OPEN). */
  smoke?: (c: Candidate) => Promise<boolean | null>
  /** OPTIONAL patched resolved K-of-N hard signal; absent ⇒ null (FAIL-OPEN). */
  resolvedKofN?: (c: Candidate) => Promise<ResolvedKofNSignal | null>
  /** OPTIONAL typed discovered public-regression receipt. */
  publicRegressionProof?: (c: Candidate) => Promise<PublicRegressionProofReceipt | null>
  /** OPTIONAL typed repro-consensus receipt. */
  reproConsensusProof?: (c: Candidate) => Promise<ReproConsensusProofReceipt | null>
  /** OPTIONAL issue-declared expected-behavior patch-shape signal; absent ⇒ null.
   *  `true` is ranking credit. `false` is explicit public issue-shape evidence
   *  that the patch implements the wrong behavior, so the selector rejects it. */
  declaredExpected?: (c: Candidate) => Promise<boolean | null>
  /** OPTIONAL parsed-static sanity hard signal. Runs on base + candidate patch.
   *  Non-empty reason list means the patched tree violates a deterministic
   *  language/runtime invariant and cannot be submitted. Absent/null ⇒ fail-open. */
  staticSanity?: (c: Candidate) => Promise<readonly string[] | null>
  /** SCAFF-06 — OPTIONAL executable public-MWE probe. Runs the extracted public
   *  MWE against base + this candidate (same env) and returns the typed proof
   *  receipt. Absent ⇒ candidates keep any generation-set receipt (or none), so
   *  selection is byte-identical. When present it OVERRIDES a generation-set
   *  receipt — selection-time execution is the authority. `null` ⇒ no receipt. */
  mweProof?: (c: Candidate) => Promise<MweProofReceipt | null>
  /** OPTIONAL typed structural family/contract repair derived from an already-
   *  generated candidate. This is bounded, generic, and patch-local: it can
   *  only inspect the candidate's touched files plus public source evidence. */
  deriveCandidateStructuralRepair?: (
    c: Candidate,
  ) => Promise<DerivedCandidateStructuralRepair | undefined>
}

export interface ScoredEntry {
  candidate: Candidate
  hard: HardGateSignals
  resolvedKofN: ResolvedKofNSignal | null
  voterQuorum: number | null
  verdict: CandidateVerdict
  requiredContractsSatisfied: number
  contractsSatisfied: number
}

export type SelectionProofState =
  | "proof_positive"
  | "proof_missing"
  | "infra_blocked"
  | "candidate_red"
  | "safety_only"

export type SelectionProofSource = "mwe_public_issue" | "repro_consensus" | "none"

export interface SelectionProofSummary {
  readonly proofState: SelectionProofState
  readonly proofSource: SelectionProofSource
  readonly proofRequiredMissing: boolean
  readonly contractOnlySubmitted: boolean
  readonly contractOnlyBlocked: boolean
  readonly publicMweState?: MweProofState
  readonly publicRegressionState?: PublicRegressionProofState
  readonly reproConsensusState?: ReproConsensusProofState
  readonly repairOnlyCandidates: number
  readonly submittedCandidateProof: boolean
}

export type SelectionNoWinnerReason =
  | "proof_required_missing"
  | "proof_infra_blocked"
  | "no_submittable_candidate"

export interface SelectionRiskGateDecision {
  readonly expand: boolean
  readonly reasons: readonly string[]
  readonly shadow?: SelectionRiskGateShadowDecision
  /** Optional typed runtime packet for the PRE-proof candidate-review screen. */
  readonly llmEvidencePacket?: LlmEvidencePacket
  /** Structural patch-budget verdict for candidate 0 — forwarded (not re-parsed)
   *  so the counterfactual seed/contract path consumes typed facts. Present only
   *  on the structural arm. */
  readonly patchBudget?: PatchBudgetVerdict
}

export interface SelectionRiskGateShadowDecision {
  readonly expand: boolean
  readonly reasons: readonly string[]
}

export interface SelectionRiskGateTelemetry {
  readonly candidateId: string
  readonly expanded: boolean
  readonly reasons: readonly string[]
  readonly shadow?: SelectionRiskGateShadowTelemetry
}

export interface SelectionRiskGateShadowTelemetry {
  readonly expanded: boolean
  readonly reasons: readonly string[]
}

export interface SelectionResult {
  /** Requested candidate count (`args.n`). */
  attempted: number
  /** Canonical owner files used for seed generation and owner-coverage scoring. */
  ownerFiles: readonly string[]
  /** True when an explicit progressive mode stopped before generating all N. */
  earlyAccepted: boolean
  /** Successful generate() calls BEFORE dedup. */
  successfulGenerations: number
  /** generate() calls that failed/aborted and were skipped. */
  generationFailures: number
  /** Winning candidate (highest-scoring admissible, else constrained
   *  best-effort). null when 0 generated OR every structurally submittable
   *  candidate is explicitly hard-rejected. */
  winner: Candidate | null
  /** Highest-scoring terminal candidate when nothing was submittable. Lets the
   *  caller preserve stop-reason/error/edit metadata even when `winner=null`. */
  terminalCandidate: Candidate | null
  /** Per-candidate scoring (post-dedup), generation order. */
  scored: ScoredEntry[]
  /** How many candidates were admissible. */
  admissibleCount: number
  /** Distinct (deduped) candidate count. */
  generated: number
  /** v4 proof-clean submit rail active for this selection pass. */
  proofRequired: boolean
  /** Why no winner existed, when the selector can distinguish the cause. */
  noWinnerReason?: SelectionNoWinnerReason
  /** Adaptive strict@1 gate telemetry, present only when the gate was enabled
   *  and candidate 0 was produced. */
  riskGate?: SelectionRiskGateTelemetry
  /** Counterfactual-select telemetry, present only when the counterfactual arm
   *  was enabled. `seedGenerated=false` means candidate 0 never expanded. */
  counterfactual?: CounterfactualTelemetry
}

export interface CounterfactualTelemetry {
  /** True when the counterfactual arm was active for this selection pass. */
  readonly enabled: boolean
  /** True when a counterfactual seed was generated for candidate 1+. */
  readonly seedGenerated: boolean
  /** Structural contracts derived from candidate 0's risk facts. */
  readonly contracts: readonly string[]
  /** Candidate ids generated under the counterfactual seed. */
  readonly candidateIds: readonly string[]
  /** Counterfactual candidate ids that VIOLATED their contract (excluded from
   *  winning over candidate 0, kept only as terminal metadata). */
  readonly violatedCandidateIds: readonly string[]
}

export type ResolvedKofNMode = "hard" | "soft"

interface SelectorRepairSeedPlan {
  readonly summary: string
  readonly directive: string
  readonly includeFamilyRepair: boolean
  readonly includeReproFailureTrace: boolean
  readonly includeOracleFailureSeed: boolean
}

/** Compact, JSON-friendly per-candidate view (NO full patch — too big for the
 *  sidecar). The `reasons` carry the hard-gate rejections + soft signals from
 *  {@link scoreCandidate}, so the cause-vs-symptom story is readable directly:
 *  e.g. `{files:[blockmatrix.py], admissible:false, reasons:[hard:regressionGreen=false]}`
 *  next to `{files:[matexpr.py], admissible:true, reasons:[soft:ownerCoverage=1]}`. */
export interface CandidateTelemetry {
  id: string
  files: readonly string[]
  admissible: boolean
  score: number
  reasons: readonly string[]
  familyId?: CandidateFamilyId
  familyReason?: string
  familyOwnerFiles?: readonly string[]
  familyCoverageMissing?: readonly string[]
  requiredContractsSatisfied?: number
  contractsSatisfied?: number
  /** SCAFF-06 — executable public-MWE proof verdict for this candidate
   *  (`patched_green` / `candidate_red` / `execution_failed` / …). Present only
   *  when an MWE receipt was produced, so a resolved/failed case can be ATTRIBUTED
   *  to the MWE tier (vs contracts/family) when reading the bench report. */
  mwe?: MweProofState
  publicRegression?: PublicRegressionProofState
  reproConsensus?: ReproConsensusProofState
  /** v4 proof-clean classification: positive proof, missing proof, infra, or
   *  safety-only keep-green. */
  proofState?: SelectionProofState
  proofSource?: SelectionProofSource
}

/** Eval-only selection telemetry — what the executor decided and WHY, so a
 *  verify-select campaign self-diagnoses (which fix SITES the N candidates
 *  spanned, which were admissible, which won). NEVER fed to the agent loop. */
export interface SelectionTelemetry {
  attempted: number
  /** Canonical owner files used by this selection pass. */
  ownerFiles: readonly string[]
  earlyAccepted: boolean
  successfulGenerations: number
  generationFailures: number
  generated: number
  admissibleCount: number
  winnerId: string | null
  proofRequired?: boolean
  noWinnerReason?: SelectionNoWinnerReason
  winningFamilyId?: CandidateFamilyId
  riskGate?: SelectionRiskGateTelemetry
  counterfactual?: CounterfactualTelemetry
  proofSummary?: SelectionProofSummary
  candidates: readonly CandidateTelemetry[]
}

const publicRegressionStateOf = (args: {
  readonly hard: HardGateSignals
  readonly receipt: PublicRegressionProofReceipt | undefined
}): PublicRegressionProofState | undefined => {
  if (args.receipt !== undefined) return args.receipt.state
  if (args.hard.regressionGreen === true) return "safety_green"
  if (args.hard.regressionGreen === false) return "candidate_red"
  return undefined
}

const reproConsensusStateOf = (args: {
  readonly resolved: ResolvedKofNSignal | null
  readonly receipt: ReproConsensusProofReceipt | undefined
}): ReproConsensusProofState | undefined => {
  if (args.receipt !== undefined) return args.receipt.state
  if (resolvedKofNPositive(args.resolved)) return "base_red_candidate_green"
  if (hardResolvedRejected(args.resolved)) return "base_red_candidate_red"
  return undefined
}

const positiveSubmitProofSource = (args: {
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

const selectionProofState = (args: {
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

const selectionProofStateForEntry = (
  entry: Pick<ScoredEntry, "candidate" | "hard" | "resolvedKofN">,
): SelectionProofState =>
  selectionProofState({
    resolved: entry.resolvedKofN,
    hard: entry.hard,
    mweReceipt: entry.candidate.mweReceipt,
    publicRegressionReceipt: entry.candidate.publicRegressionReceipt,
    reproConsensusReceipt: entry.candidate.reproConsensusReceipt,
  })

const hasContractOnlyEvidence = (entry: ScoredEntry): boolean =>
  entry.requiredContractsSatisfied > 0 ||
  entry.contractsSatisfied > 0 ||
  familyAuthorityPresent(entry.candidate)

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
  const contractOnlySubmitted = winnerEntry !== undefined && !submittedCandidateProof && hasContractOnlyEvidence(winnerEntry)
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
      result.winner === null && result.noWinnerReason === "proof_required_missing" && repairOnlyCandidates > 0,
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
    repairOnlyCandidates,
    submittedCandidateProof,
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
    ...(proofSummary !== undefined ? { proofSummary } : {}),
    candidates: result.scored.map((s) => {
      const publicRegression =
        s.candidate.publicRegressionReceipt?.state ??
        publicRegressionStateOf({ hard: s.hard, receipt: undefined })
      const reproConsensus =
        s.candidate.reproConsensusReceipt?.state ??
        reproConsensusStateOf({ resolved: s.resolvedKofN, receipt: undefined })
      return {
        id: s.candidate.id,
        files: s.candidate.files,
        admissible: s.verdict.admissible,
        score: s.verdict.score,
        reasons: s.verdict.reasons,
        ...(s.candidate.familyId !== undefined ? { familyId: s.candidate.familyId } : {}),
        ...(s.candidate.familyReason !== undefined
          ? { familyReason: s.candidate.familyReason }
          : {}),
        ...(s.candidate.familyOwnerFiles !== undefined
          ? { familyOwnerFiles: s.candidate.familyOwnerFiles }
          : {}),
        ...(() => {
          if (s.candidate.familyId === undefined) return {}
          const missing = candidateFamilyCoverageMissing(
            {
              familyId: s.candidate.familyId,
              ownerFiles: s.candidate.familyOwnerFiles ?? [],
            },
            s.candidate.files,
          )
          return missing.length === 0 ? {} : { familyCoverageMissing: missing }
        })(),
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
    }),
  }
}

const fwd = (s: string): string => s.split(sep).join("/").replace(/\\/g, "/")

const relInsideSandbox = (path: string, sandbox: string | undefined): string | null => {
  if (!isAbsolute(path)) return path
  if (sandbox === undefined) return null
  const rel = relative(sandbox, path)
  return rel === "" || rel.startsWith("..") ? null : fwd(rel)
}

const normalizePathParts = (path: string): string | null => {
  const parts: string[] = []
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") return null
    parts.push(part)
  }
  const out = parts.join("/")
  return out === "" || out === "dev/null" ? null : out
}

/** Canonical repo-relative path used by selection owners and candidate patches.
 *  Absolute paths are accepted only when they are inside the active sandbox. */
export const normalizeSelectionPath = (raw: string, sandbox: string | undefined): string | null => {
  let p = fwd(raw.trim().replace(/^["'`]+|["'`]+$/g, ""))
  if (p === "" || p === "/dev/null") return null
  const rel = relInsideSandbox(p, sandbox)
  if (rel === null) return null
  p = rel
  // Generic selection paths are repo-relative authorities, not raw git diff
  // headers. Stripping a leading `a/` or `b/` here would collapse real paths
  // like `a/pkg/file.py` onto `pkg/file.py`.
  p = p.replace(/^\.\//, "")
  return normalizePathParts(p)
}

export const normalizeSelectionPaths = (
  paths: readonly string[],
  sandbox: string | undefined,
): string[] => {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of paths) {
    const p = normalizeSelectionPath(raw, sandbox)
    if (p === null || seen.has(p)) continue
    seen.add(p)
    out.push(p)
  }
  return out
}

/** Repo-relative files a unified diff touches (its `+++ b/<f>` headers, plus
 *  `--- a/<f>` for pure deletions). Used for owner-coverage scoring. */
export const filesFromPatch = (patch: string): string[] => {
  const files = new Set<string>()
  for (const raw of filesFromUnifiedDiff(patch)) {
    const f = normalizeSelectionPath(raw, undefined)
    if (f !== null) files.add(f)
  }
  return [...files]
}

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

/** Normalize a diff to its `+++ b/` / `--- a/` FILE headers plus `+/-` CONTENT
 *  lines (dropping `@@` hunk-offset noise + context) so two patches dedup only
 *  when they make the SAME edit to the SAME file(s). Keeping the file headers is
 *  deliberate: the SAME content edit on DIFFERENT files is a DIFFERENT fix site
 *  (the diversity the executor exists to span) and must NOT collide. */
const normalizePatch = (patch: string): string =>
  patch
    .split("\n")
    .filter((l) => /^[+-]/.test(l))
    .map((l) => l.trimEnd())
    .join("\n")

/** Fraction of a candidate's files that are closure-ranked owners. `null` when
 *  the candidate touches no file OR no owner set is known (uninformative ⇒
 *  fail-open soft signal, contributes nothing rather than a misleading 0). */
export const ownerCoverageOf = (
  files: readonly string[],
  owners: ReadonlySet<string>,
): number | null => {
  if (files.length === 0 || owners.size === 0) return null
  const hit = files.filter((f) => owners.has(f)).length
  return hit / files.length
}

const fullyInsideOwners = (files: readonly string[], owners: ReadonlySet<string>): boolean =>
  owners.size > 0 && files.length > 0 && files.every((f) => owners.has(f))

const earlyAcceptable = (
  entry: ScoredEntry,
  owners: ReadonlySet<string>,
  requireHardResolved: boolean,
  mode: SelectorMode,
): boolean => {
  if (!entry.verdict.admissible) return false
  // Early-stop authority is STRICTER than admissibility: fail-open `null` gates
  // keep a candidate admissible, but they are not strong enough to stop the
  // loop. The progressive shortcut requires an explicitly clean-applying patch.
  if (!entry.hard.patchProduced || entry.hard.applyClean !== true) return false
  const resolved = entry.hard.patchedResolvedKofN
  // Executed proof receipt: a positive validated repro quorum OR an executed
  // clean keep-green witness result.
  const executedProof = resolvedKofNPositive(resolved) || entry.hard.regressionGreen === true
  if (mode === "clean") {
    // T-SEL-13: clean early-stop requires an EXECUTED proof receipt ONLY. No
    // static owner/family heuristic may stop the search by itself — a candidate
    // fully inside the (heuristic) owner set cannot early-accept without proof,
    // and strong static owner confidence never short-circuits the loop.
    return executedProof
  }
  // research/legacy cost shortcut (byte-identical): owner-coverage gated.
  // No owner authority => no early stop (collapses to "first positive wins").
  if (owners.size === 0) return false
  // A positive candidate may stop the loop only when every touched file is inside
  // the owner set; broad symptom+stray patches still face later owner siblings.
  if (!fullyInsideOwners(entry.candidate.files, owners)) return false
  if (requireHardResolved) return resolvedKofNPositive(resolved)
  return executedProof
}

const voterQuorumOf = (
  mode: ResolvedKofNMode,
  resolved: ResolvedKofNSignal | null,
): number | null => (mode === "soft" ? resolvedKofNVoterQuorum(resolved) : null)

const terminalAuthorityRank = (candidate: Candidate): number => {
  if (
    candidate.stopReason === "max_turns" ||
    candidate.stopReason === "budget_exhausted" ||
    candidate.stopReason === "aborted"
  ) {
    return 2
  }
  if (candidate.stopReason === "error" || candidate.stopReason === "refusal") return 1
  return 0
}

const strongerTerminalRepresentative = (current: Candidate, candidate: Candidate): Candidate =>
  terminalAuthorityRank(candidate) > terminalAuthorityRank(current) ? candidate : current

const minimalityOf = (args: {
  readonly isEmpty: boolean
  readonly size: number
  readonly minB: number
  readonly maxB: number
}): number | null => {
  if (args.isEmpty) return null
  return args.maxB === args.minB ? 1 : 1 - (args.size - args.minB) / (args.maxB - args.minB)
}

const requireHardResolvedForEarlyAccept = (
  ports: SelectionPorts,
  mode: ResolvedKofNMode | undefined,
): boolean => ports.resolvedKofN !== undefined && (mode ?? "hard") === "hard"

const declaredExpectedMatchOf = async (
  c: Candidate,
  isEmpty: boolean,
  ports: SelectionPorts,
): Promise<boolean | null> => {
  if (isEmpty) return null
  return (await ports.declaredExpected?.(c)) ?? null
}

const staticSanityReasonsOf = async (
  c: Candidate,
  isEmpty: boolean,
  ports: SelectionPorts,
): Promise<readonly string[]> => {
  if (isEmpty) return []
  return (await ports.staticSanity?.(c)) ?? []
}

const hardResolvedRejected = (signal: ResolvedKofNSignal | null): boolean => {
  if (signal === null) return false
  return !isValidResolvedKofN(signal) || signal.votes < signal.k
}

type ResolvedKofNWithTrace = ResolvedKofNSignal & {
  readonly reproTrace?: ReproConsensusTrace
}

const reproTraceOf = (signal: ResolvedKofNSignal | null): ReproConsensusTrace | undefined =>
  signal === null ? undefined : (signal as ResolvedKofNWithTrace).reproTrace

const cleanExecutableProof = (
  resolved: ResolvedKofNSignal | null,
  mweReceipt: MweProofReceipt | undefined,
  reproConsensusReceipt: ReproConsensusProofReceipt | undefined,
): boolean =>
  positiveSubmitProofSource({ resolved, mweReceipt, reproConsensusReceipt }) !== "none"

const cleanUnprovenMultiSourceDriftRisk = (args: {
  readonly mode: SelectorMode
  readonly candidate: Candidate
  readonly owners: ReadonlySet<string>
  readonly hard: HardGateSignals
  readonly resolved: ResolvedKofNSignal | null
  readonly mweReceipt: MweProofReceipt | undefined
  readonly reproConsensusReceipt: ReproConsensusProofReceipt | undefined
  readonly requiredContractsSatisfied: number
  readonly contractsSatisfied: number
}): boolean => {
  if (args.mode !== "clean") return false
  if (
    cleanExecutableProof(
      args.resolved,
      args.mweReceipt,
      args.reproConsensusReceipt,
    ) ||
    args.requiredContractsSatisfied > 0 ||
    args.contractsSatisfied > 0
  ) {
    return false
  }
  const budget = analyzePatchBudget(args.candidate.patch, {
    ownerFiles: [...args.owners],
  }).budget
  return budget.sourceFiles > 1
}

const CLEAN_DRIFT_REJECT_REASON =
  "hard:unprovenMultiSourceDriftRisk=true (multi-source patch lacks executable proof or public contract)"

const MWE_CANDIDATE_RED_REJECT_REASON =
  "hard:mweProof=candidate_red (public issue MWE still fails after patch)"

const CLEAN_AUTHORITY_MISSING_REJECT_REASON =
  "hard:cleanProofAuthorityMissing=true (clean mode has no owner, executable proof, public contract, or static witness authority)"

const PROOF_REQUIRED_MISSING_REJECT_REASON =
  "hard:proofRequiredMissing=true (proof-required mode requires positive executed proof; safety or structural evidence alone cannot submit)"

const PROOF_INFRA_BLOCKED_REJECT_REASON =
  "hard:proofInfraBlocked=true (public proof execution failed; do not treat this as candidate correctness)"

const applyCleanDriftHardGate = (verdict: CandidateVerdict, risk: boolean): CandidateVerdict =>
  risk
    ? {
        admissible: false,
        score: verdict.score,
        reasons: [...verdict.reasons, CLEAN_DRIFT_REJECT_REASON],
      }
    : verdict

const applyMweProofHardGate = (
  verdict: CandidateVerdict,
  mode: SelectorMode,
  receipt: MweProofReceipt | undefined,
): CandidateVerdict =>
  mode === "clean" && receipt?.state === "candidate_red"
    ? {
        admissible: false,
        score: verdict.score,
        reasons: [...verdict.reasons, MWE_CANDIDATE_RED_REJECT_REASON],
      }
    : verdict

const familyAuthorityPresent = (candidate: Candidate): boolean =>
  candidateFamilyRank(
    candidate.familyId === undefined
      ? undefined
      : {
          familyId: candidate.familyId,
          ownerFiles: candidate.familyOwnerFiles ?? [],
        },
    candidate.files,
  ) > 0

const cleanProofAuthorityMissing = (args: {
  readonly mode: SelectorMode
  readonly owners: ReadonlySet<string>
  readonly candidate: Candidate
  readonly hard: HardGateSignals
  readonly resolved: ResolvedKofNSignal | null
  readonly mweReceipt: MweProofReceipt | undefined
  readonly reproConsensusReceipt: ReproConsensusProofReceipt | undefined
  readonly requiredContractsSatisfied: number
  readonly contractsSatisfied: number
}): boolean =>
  args.mode === "clean" &&
  args.candidate.patch.trim() !== "" &&
  args.owners.size === 0 &&
  !cleanExecutableProof(
    args.resolved,
    args.mweReceipt,
    args.reproConsensusReceipt,
  ) &&
  args.requiredContractsSatisfied === 0 &&
  args.contractsSatisfied === 0 &&
  !familyAuthorityPresent(args.candidate)

const applyCleanAuthorityHardGate = (
  verdict: CandidateVerdict,
  missing: boolean,
): CandidateVerdict =>
  missing
    ? {
        admissible: false,
        score: verdict.score,
        reasons: [...verdict.reasons, CLEAN_AUTHORITY_MISSING_REJECT_REASON],
      }
    : verdict

const applyProofRequiredHardGate = (
  verdict: CandidateVerdict,
  enabled: boolean,
  proofState: SelectionProofState,
): CandidateVerdict => {
  if (!enabled || proofState === "proof_positive") return verdict
  return {
    admissible: false,
    score: verdict.score,
    reasons: [
      ...verdict.reasons,
      proofState === "infra_blocked"
        ? PROOF_INFRA_BLOCKED_REJECT_REASON
        : PROOF_REQUIRED_MISSING_REJECT_REASON,
    ],
  }
}

const applyStaticSanityHardGate = (
  verdict: CandidateVerdict,
  reasons: readonly string[],
): CandidateVerdict =>
  reasons.length === 0
    ? verdict
    : {
        admissible: false,
        score: verdict.score,
        reasons: [...verdict.reasons, ...reasons],
      }

const DECLARED_EXPECTED_REJECT_REASON =
  "hard:declaredExpectedMatch=false (candidate contradicts issue-declared expected behavior)"

const applyDeclaredExpectedHardGate = (
  verdict: CandidateVerdict,
  declaredExpectedMatch: boolean | null,
): CandidateVerdict =>
  declaredExpectedMatch === false
    ? {
        admissible: false,
        score: verdict.score,
        reasons: [...verdict.reasons, DECLARED_EXPECTED_REJECT_REASON],
      }
    : verdict

/**
 * Score under the active authority mode (T-AUTH-01 / T-SEL-02). `declaredExpected`
 * is a `researchOnly` signal: it may hard-reject ONLY in `research` mode. In
 * `clean` mode it never vetoes — the answer-key matcher carries no clean
 * benchmark authority (it survives only as research telemetry behind rca-gates).
 */
const scoreWithAuthority = (
  hard: HardGateSignals,
  soft: SoftScoreSignals,
  declaredExpectedMatch: boolean | null,
  mode: SelectorMode,
): CandidateVerdict => {
  const verdict = scoreCandidate(hard, soft, { mode })
  return mode === "clean" ? verdict : applyDeclaredExpectedHardGate(verdict, declaredExpectedMatch)
}

const countAddedSourceLines = (patch: string): number => {
  let n = 0
  for (const line of patch.split("\n")) if (line.startsWith("+") && !line.startsWith("+++")) n += 1
  return n
}

/**
 * Project a scored candidate into the clean-selector lexicographic tiers
 * (T-SEL-06). Executable proof (`votes/k`) + executed keep-green are the top
 * tiers. The public-contract tier (T-CON-10) is evaluated from `contracts` — but
 * only GENUINELY-sourced contracts the caller supplies; it is empty by default
 * (the closure owner ranking is heuristic and must not be promoted into this
 * tier — see runSelection). The candidate-family tier (T-GEN-09) stays 0 until
 * authoritative family evidence (T-OWN-12) exists; both slot in ABOVE minimality
 * WITHOUT disturbing the executable/structural tiers above.
 */
const buildLexTiers = (
  entry: ScoredEntry,
  order: number,
  owners: ReadonlySet<string>,
  contracts: PublicContractBundle,
): LexTiers => {
  const kofn = entry.resolvedKofN ?? entry.hard.patchedResolvedKofN
  const proofStrength =
    kofn !== null && isValidResolvedKofN(kofn) && kofn.k > 0 ? kofn.votes / kofn.k : 0
  const budget = analyzePatchBudget(entry.candidate.patch, { ownerFiles: [...owners] }).budget
  const candidate = {
    touchedFiles: entry.candidate.files,
    touchedSymbols: diffTouchedSymbols(entry.candidate.patch),
  }
  const effectiveContracts =
    mergePublicContractBundles(contracts, entry.candidate.publicContracts) ?? contracts
  return {
    mweProof: mweProofAuthorityRank(entry.candidate.mweReceipt),
    proofStrength,
    executedKeepGreen: entry.hard.regressionGreen === true ? 1 : 0,
    requiredContractsSatisfied: requiredContractsSatisfiedCount(effectiveContracts, candidate),
    contractsSatisfied: contractsSatisfiedCount(effectiveContracts, candidate),
    familyRank: candidateFamilyRank(
      entry.candidate.familyId === undefined
        ? undefined
        : {
            familyId: entry.candidate.familyId,
            ownerFiles: entry.candidate.familyOwnerFiles ?? [],
          },
      entry.candidate.files,
    ),
    sourceFiles: budget.sourceFiles,
    addedLines: countAddedSourceLines(entry.candidate.patch),
    newDefs: budget.newDefs,
    newFiles: budget.newFiles,
    order,
  }
}

const declaredExpectedRejected = (verdict: CandidateVerdict): boolean =>
  verdict.reasons.includes(DECLARED_EXPECTED_REJECT_REASON)

const cleanDriftRejected = (verdict: CandidateVerdict): boolean =>
  verdict.reasons.includes(CLEAN_DRIFT_REJECT_REASON)

const mweCandidateRedRejected = (verdict: CandidateVerdict): boolean =>
  verdict.reasons.includes(MWE_CANDIDATE_RED_REJECT_REASON)

const cleanAuthorityMissingRejected = (verdict: CandidateVerdict): boolean =>
  verdict.reasons.includes(CLEAN_AUTHORITY_MISSING_REJECT_REASON)

const proofRequiredRejected = (verdict: CandidateVerdict): boolean =>
  verdict.reasons.includes(PROOF_REQUIRED_MISSING_REJECT_REASON) ||
  verdict.reasons.includes(PROOF_INFRA_BLOCKED_REJECT_REASON)

// B#3: a static-sanity hard reject is a DETERMINISTIC parse-level "this patch is
// broken" signal (e.g. callback arity mismatch, None-subscript mutation). Like
// the other hard vetoes it must also bar the best-effort fallback — otherwise a
// no-other-candidate run resurrects the broken patch via best-effort and submits
// it. (Matches the audit rule: selectBestEffort must not resubmit a candidate
// carrying explicit negative evidence.)
const staticSanityRejected = (verdict: CandidateVerdict): boolean =>
  verdict.reasons.some((reason) => reason.startsWith("hard:staticSanity="))

const bestEffortEligible = (
  entry: Pick<ScoredEntry, "hard" | "verdict">,
  mode: SelectorMode,
): boolean => {
  if (!entry.hard.patchProduced) return false
  if (entry.hard.applyClean === false) return false
  if (entry.hard.regressionGreen === false) return false
  if (mode !== "clean" && entry.hard.smokeGreen === false) return false
  if (hardResolvedRejected(entry.hard.patchedResolvedKofN)) return false
  if (declaredExpectedRejected(entry.verdict)) return false
  if (cleanDriftRejected(entry.verdict)) return false
  if (mweCandidateRedRejected(entry.verdict)) return false
  if (cleanAuthorityMissingRejected(entry.verdict)) return false
  if (proofRequiredRejected(entry.verdict)) return false
  if (staticSanityRejected(entry.verdict)) return false
  return true
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
            mergePublicContractBundles(candidate.publicContracts, publicContracts) ?? publicContracts,
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
      return maybeRepairFamilyCoverage(candidate, derived.family, seed, index, derived.publicContracts)
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
      reproConsensusReceipt:
        (await args.ports.reproConsensusProof?.(c)) ?? c.reproConsensusReceipt,
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

  const hasNonEmptyPatch = (entry: ScoredEntry): boolean => entry.candidate.patch.trim() !== ""

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

  const reproOracleRepairRequired = (scored: readonly ScoredEntry[]): boolean => {
    if (args.oracleFailureRepairSeed === undefined) return false
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

  const cleanDriftRepairRequired = (scored: readonly ScoredEntry[]): boolean => {
    const patched = scored.filter(hasNonEmptyPatch)
    return (
      patched.length > 0 &&
      !patched.some((s) => s.verdict.admissible) &&
      patched.every((s) => cleanDriftRejected(s.verdict))
    )
  }

  const bounded = (s: string | undefined, n = 1800): string => {
    const v = s ?? ""
    return v.length > n ? v.slice(-n) : v
  }

  const bestMissingFamily = (scored: readonly ScoredEntry[]): CandidateFamily | undefined => {
    const ranked = scored
      .map((entry, order) => ({
        family: familyFromCandidate(entry.candidate),
        missing: candidateFamilyCoverageMissing(
          familyFromCandidate(entry.candidate),
          entry.candidate.files,
        ),
        order,
      }))
      .filter(
        (
          entry,
        ): entry is {
          family: CandidateFamily
          missing: string[]
          order: number
        } => entry.family !== undefined && entry.missing.length > 0,
      )
      .sort((a, b) => a.family.ownerFiles.length - b.family.ownerFiles.length || a.order - b.order)
    return ranked[0]?.family
  }

  const familyRepairSeed = (scored: readonly ScoredEntry[]): string | undefined => {
    const family = bestMissingFamily(scored)
    if (family === undefined) return undefined
    return seedForCandidateFamilyCoverageRepair(
      family,
      candidateFamilyCoverageMissing(family, []),
    )
  }

  const staticSanityReasons = (entry: ScoredEntry): readonly string[] =>
    entry.verdict.reasons.filter((reason) => reason.startsWith("hard:staticSanity="))

  const staticSanityInstruction = (reason: string): string => {
    const noneMutation =
      /^hard:staticSanity=pythonNoneSubscriptMutation\(([^)]+)\)$/.exec(reason)?.[1]
    if (noneMutation !== undefined) {
      return `Static sanity failure: \`${noneMutation}\` can be None before a subscript write. Regenerate so every \`${noneMutation}[...]\` mutation is protected by a non-None mapping invariant, or guard each mutation site that may observe None.`
    }
    const arity =
      /^hard:staticSanity=pythonCallbackArityMismatch\(([^:]+):(\d+)->(\d+)\)$/.exec(reason)
    if (arity !== null) {
      return `Static sanity failure: callback \`${arity[1]}\` is registered with positional arity ${arity[3]}, but its definition accepts ${arity[2]}. Regenerate so the registration and callback signature agree exactly.`
    }
    return `Static sanity failure: ${reason.replace("hard:staticSanity=", "")}. Regenerate from the base tree and remove this deterministic parse-level violation without dropping the stronger structural fix.`
  }

  const staticSanityRepairSeed = (scored: readonly ScoredEntry[], winner: Candidate | null): string | undefined => {
    const winnerEntry = winner === null ? undefined : scored.find((entry) => entry.candidate.id === winner.id)
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
    const targetFamily = familyFromCandidate(target.candidate)
    return [
      "Selector feedback: a previous candidate reached stronger structural/public coverage, but it was rejected by deterministic static sanity checks.",
      ...(targetFamily === undefined ? [] : [seedForCandidateFamily(targetFamily)]),
      ...staticSanityReasons(target).map(staticSanityInstruction),
      "Regenerate from the base tree. Preserve the stronger structural coverage while removing the static sanity violation; do not retreat to a smaller partial patch unless the stronger coverage is disproven by public source evidence.",
    ]
      .filter((s) => s.trim() !== "")
      .join("\n\n")
  }

  const mweProofReceiptFacts = (candidate: Candidate): ProofReceiptFact[] => {
    const receipt = candidate.mweReceipt
    if (receipt === undefined) return []
    const patchHash =
      candidate.patch.trim() === "" ? undefined : candidatePatchHash(candidate.patch)
    const state: ProofReceiptState =
      receipt.state === "base_red"
        ? "base_red"
        : receipt.state === "base_not_red"
          ? "base_green"
          : receipt.state === "patched_green"
            ? "candidate_green"
            : receipt.state === "candidate_red"
              ? "candidate_red"
              : receipt.state === "execution_failed"
                ? "execution_failed"
                : "not_run"
    return [
      {
        source: "public_mwe",
        state,
        ...(receipt.command !== undefined ? { command: receipt.command } : {}),
        ...(patchHash !== undefined ? { candidatePatchHash: patchHash } : {}),
      },
    ]
  }

  const publicRegressionReceiptFacts = (candidate: Candidate): ProofReceiptFact[] => {
    const receipt = candidate.publicRegressionReceipt
    if (receipt === undefined) return []
    const patchHash =
      candidate.patch.trim() === "" ? undefined : candidatePatchHash(candidate.patch)
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

  const reproConsensusReceiptFacts = (candidate: Candidate): ProofReceiptFact[] => {
    const receipt = candidate.reproConsensusReceipt
    if (receipt === undefined) return []
    const patchHash =
      candidate.patch.trim() === "" ? undefined : candidatePatchHash(candidate.patch)
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
          ? { stdoutTail: bounded(sample.stdoutTail, 600) }
          : {}),
        ...(sample?.stderrTail !== undefined && sample.stderrTail.trim() !== ""
          ? { stderrTail: bounded(sample.stderrTail, 600) }
          : {}),
        ...(patchHash !== undefined ? { candidatePatchHash: patchHash } : {}),
      },
    ]
  }

  const hardReasonState = (reason: string): ProofReceiptState =>
    reason.includes("proofInfraBlocked")
      ? "execution_failed"
      : reason.includes("proofRequiredMissing")
        ? "not_run"
      : /candidate_red|=false|red\b/.test(reason)
      ? "candidate_red"
      : reason.includes("staticSanity")
        ? "static_only"
        : "not_run"

  const repairPacketText = (
    scored: readonly ScoredEntry[],
    seed: string,
    winner: Candidate | null,
  ): string => {
    const focusCandidate =
      (winner !== null && winner.patch.trim() !== "" ? winner : null) ??
      scored.find(hasNonEmptyPatch)?.candidate
    const patchAuthority = focusCandidate?.patch ?? scored[0]?.candidate.patch ?? seed
    const proofReceipts: ProofReceiptFact[] = [
      ...scored.flatMap((entry) => [
        ...mweProofReceiptFacts(entry.candidate),
        ...publicRegressionReceiptFacts(entry.candidate),
        ...reproConsensusReceiptFacts(entry.candidate),
      ]),
      ...scored
        .flatMap((entry) => entry.verdict.reasons.filter((reason) => reason.startsWith("hard:")).slice(0, 2))
        .map((reason) => ({ source: reason, state: hardReasonState(reason) })),
    ]
    const ownerFiles = [
      ...new Set(
        focusCandidate === undefined
          ? scored.flatMap((entry) => entry.candidate.familyOwnerFiles ?? entry.candidate.files)
          : (focusCandidate.familyOwnerFiles ?? focusCandidate.files),
      ),
    ]
    const ownerEvidence: OwnerEvidenceFact[] = ownerFiles.map((file) => ({
      file,
      symbols: [],
      provenance: "repair-owner",
    }))
    const contracts: ContractFact[] =
      focusCandidate === undefined
        ? []
        : (() => {
            const effectiveContracts = mergePublicContractBundles(
              contractBundle,
              focusCandidate.publicContracts,
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
              authority: `${contract.provenance}/${contract.strength}`,
              satisfied: evaluations.get(contract.contractId)?.satisfied ?? "unknown",
            }))
          })()
    const packet = buildRepairSeedLlmEvidencePacket({
      problemStatement: args.problemStatement ?? "",
      candidatePatchHash: candidatePatchHash(patchAuthority),
      ownerEvidence,
      proofReceipts,
      contracts,
      repairGuidance: seed,
      ...(args.verificationTarget !== undefined ? { verificationTarget: args.verificationTarget } : {}),
    })
    args.recordLlmEvidencePacket?.(packet)
    return renderLlmEvidencePacket(packet)
  }

  const reproFailureTraceSeed = (scored: readonly ScoredEntry[]): string | undefined => {
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
            : `stdout tail:\n${bounded(sample.stdoutTail)}`,
          sample.stderrTail.trim() === ""
            ? "stderr tail: <empty>"
            : `stderr tail:\n${bounded(sample.stderrTail)}`,
        ].join("\n"),
      )
    return [
      `Selector failure trace from ${entry.candidate.id}: votes=${entry.resolvedKofN.votes}, k=${entry.resolvedKofN.k}; vote=${trace.vote.verdict} (resolved=${trace.vote.resolved}, reproduced=${trace.vote.reproduced}, inconclusive=${trace.vote.inconclusive}).`,
      ...samples,
    ].join("\n\n")
  }

  const oracleFailureRepairSeed = (scored: readonly ScoredEntry[]): string | undefined => {
    const patched = scored.filter(hasNonEmptyPatch)
    const proofStates = patched.map((entry) => selectionProofStateForEntry(entry))
    const plan = (() : SelectorRepairSeedPlan | undefined => {
      if (
        proofRequired &&
        patched.length > 0 &&
        patched.some(
          (entry) =>
            entry.candidate.mweReceipt !== undefined ||
            entry.candidate.publicRegressionReceipt !== undefined ||
            entry.candidate.reproConsensusReceipt !== undefined,
        ) &&
        proofStates.every((state) => state === "infra_blocked")
      ) {
        return {
          summary:
            "Selector feedback: every generated candidate reached public proof execution, but each run failed in infra/runtime without producing a candidate-correctness verdict.",
          directive:
            "Regenerate from the base tree. Preserve the strongest structural/public coverage already found, but remove candidate-side execution blockers so the named public proof can actually run to completion. Do not widen scope or invent unrelated helpers.",
          includeFamilyRepair: true,
          includeReproFailureTrace: false,
          includeOracleFailureSeed: true,
        }
      }
      if (mweOracleRepairRequired(scored)) {
        return {
          summary:
            "Selector feedback: every generated candidate was executed against a public issue MWE that reproduced on the base tree, and every candidate still failed that MWE.",
          directive:
            "Regenerate from the base tree. Treat the public MWE in the issue text as the executable contract: the patch must make that MWE pass without broadening the edit beyond the necessary source change.",
          includeFamilyRepair: true,
          includeReproFailureTrace: false,
          includeOracleFailureSeed: true,
        }
      }
      if (reproOracleRepairRequired(scored)) {
        return {
          summary:
            "Selector feedback: every generated candidate was re-run against the base-red validated reproduction set, and none reached resolved consensus.",
          directive:
            "Regenerate from the base tree. Treat the validated reproduction script(s) below as public executable contracts: the patch must make the scripts report `Issue resolved` without adding unnecessary helpers, files, or unrelated design surface.",
          includeFamilyRepair: true,
          includeReproFailureTrace: true,
          includeOracleFailureSeed: true,
        }
      }
      if (cleanDriftRepairRequired(scored)) {
        return {
          summary:
            "Selector feedback: every generated multi-source candidate was rejected as unproven multi-source drift by clean selector authority because no executable proof or public contract justified touching multiple source files.",
          directive:
            "Regenerate from the base tree. Either produce a narrow single-owner patch, or include the complete static/public witness that justifies every source file touched. Do not add helper files, new definitions, or unrelated design surface unless that witness requires them.",
          includeFamilyRepair: false,
          includeReproFailureTrace: false,
          includeOracleFailureSeed: true,
        }
      }
      if (
        proofRequired &&
        patched.length > 0 &&
        !proofStates.some((state) => state === "proof_positive") &&
        patched.some(hasContractOnlyEvidence)
      ) {
        return {
          summary:
            "Selector feedback: at least one generated candidate achieved structural/public contract coverage, but no candidate produced positive executed public proof.",
          directive:
            "Regenerate from the base tree. Preserve the strongest structural/public coverage already found and make the named public proof run green. Do not broaden file scope, add unrelated helpers, or substitute structural guesses for executed proof.",
          includeFamilyRepair: true,
          includeReproFailureTrace: false,
          includeOracleFailureSeed: true,
        }
      }
      return undefined
    })()
    if (plan === undefined) return undefined
    return [
      plan.summary,
      plan.directive,
      ...(plan.includeFamilyRepair ? [familyRepairSeed(scored)] : []),
      ...(plan.includeReproFailureTrace ? [reproFailureTraceSeed(scored)] : []),
      ...(plan.includeOracleFailureSeed ? [args.oracleFailureRepairSeed] : []),
    ]
      .filter((s): s is string => s !== undefined && s.trim() !== "")
      .join("\n\n")
  }

  const maybeAppendSelectorRepair = async (
    rawCandidates: readonly Candidate[],
    result: SelectionResult,
  ): Promise<readonly Candidate[]> => {
    if (mode !== "clean" || rawCandidates.length === 0) return rawCandidates
    const seed =
      staticSanityRepairSeed(result.scored, result.winner) ?? oracleFailureRepairSeed(result.scored)
    if (seed === undefined) return rawCandidates
    try {
      const prompt = repairPacketText(result.scored, seed, result.winner)
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
        const proofStates = nonEmpty.map((entry) =>
          selectionProofStateForEntry(entry),
        )
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
