/**
 * Shared type surface for the verify-and-select selection executor. Pure type
 * declarations lifted out of {@link ./selection-executor} so the helper modules
 * (paths / proof-telemetry / gates / repair-seed) can reference them without a
 * value-import cycle. Every type here is re-exported from `./selection-executor`
 * so the public import surface is byte-stable.
 */

import type { StopReason } from "@/agent"
import type { PatchBudgetVerdict } from "@/agent/patch-budget"
import type {
  CandidateVerdict,
  HardGateSignals,
  ResolvedKofNSignal,
} from "@/agent/verification-bundle"
import type { CandidateFamily, CandidateFamilyId } from "./candidate-families"
import type { LlmEvidencePacket } from "./llm-evidence-packet"
import type { MweProofReceipt, MweProofState } from "./mwe-proof"
import type { PublicContractBundle } from "./public-contract-types"
import type {
  PublicRegressionProofReceipt,
  PublicRegressionProofState,
} from "./repo-regression-discovery-adapter"
import type {
  ReproConsensusProofReceipt,
  ReproConsensusProofState,
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
