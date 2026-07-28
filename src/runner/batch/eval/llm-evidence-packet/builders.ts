/**
 * OPC-07 — per-stage packet builders. Each builder declares ONE stage/question/
 * action contract and assembles a bounded, blind, cleaned packet: intake,
 * candidate generation (+ shared prompt), candidate review, candidate
 * post-review, repair seed, selection explanation, and the phase-routing
 * re-contract. Construction only — assembly/guard/hash logic lives upstream.
 */

import type { FaultEvidencePacket } from "@/agent/fault-evidence"
import type { VerificationPlan } from "@/agent/verification-plan"
import { extractIssueReproSeed } from "@/agent/verification-plan"
import type { MweProofState } from "../mwe-proof"
import type { ReproConsensusProofState } from "../repair/resolved-consensus"
import type { PublicRegressionProofState } from "../repo-regression-discovery-adapter"
import type { SelectionProofSource, SelectionProofState } from "../selection-types"
import type { StaticWitnessDiagnostic } from "../static-witness-adapter"
import {
  describeIssueFacts,
  ownerSliceMissingEvidence,
  staticWitnessDiagnosticsFacts,
  verificationTargetFromPlan,
} from "./assembly"
import { cleanPacket, renderLlmEvidencePacket } from "./clean"
import { assertEvidenceTextBlind } from "./guards"
import { opaqueInstanceIdHash } from "./hash"
import { ownerTestResultReceipt, sourcePolicyOf } from "./policy"
import { boundHead, boundTail, fmtList } from "./text-utils"
import type {
  CandidateEditSurfaceFact,
  ContractFact,
  LlmEvidencePacket,
  MissingEvidenceFact,
  OwnerEvidenceFact,
  ProofReceiptFact,
  ProofReceiptState,
  StaticFact,
  VerificationTargetFact,
} from "./types"

/* ------------------------------------------------------------------ */
/* Intake packet                                                       */
/* ------------------------------------------------------------------ */

type IntakeReproTelemetry =
  | {
      readonly installed: true
      readonly path: string
      readonly samples: number
      readonly reproducedCount: number
    }
  | {
      readonly installed: false
      readonly reason: string
      readonly samples?: number
      readonly reproducedCount?: number
      readonly sampleOutcomes?: readonly string[]
      readonly sampleStdoutTail?: string
      readonly sampleStderrTail?: string
    }

export interface IntakeLlmEvidenceInput {
  readonly problemStatement: string
  readonly localizeCandidates: readonly string[]
  readonly faultEvidence?: FaultEvidencePacket
  readonly verificationPlan?: VerificationPlan
  readonly reproTest?: IntakeReproTelemetry
}

const ownerEvidenceFromFaultEvidence = (args: {
  readonly faultEvidence?: FaultEvidencePacket
  readonly localizeCandidates: readonly string[]
}): OwnerEvidenceFact[] => {
  if (args.faultEvidence !== undefined && args.faultEvidence.candidates.length > 0) {
    return args.faultEvidence.candidates.map((candidate) => ({
      file: candidate.file,
      symbols: candidate.symbols,
      provenance: `fault-evidence:${candidate.sources.join("+")}`,
    }))
  }
  return args.localizeCandidates.map((file) => ({
    file,
    symbols: [],
    provenance: "localize-stage1",
  }))
}

const reproReceipts = (repro: IntakeReproTelemetry | undefined): ProofReceiptFact[] => {
  if (repro === undefined)
    return [{ source: "public_mwe", sourcePolicy: "public_repro", state: "not_run" }]
  if (repro.installed) {
    return [
      {
        source: "public_mwe",
        sourcePolicy: "public_repro",
        state: repro.reproducedCount > 0 ? "base_red" : "base_green",
        command: repro.path,
      },
    ]
  }
  return [
    {
      source: "public_mwe",
      // B8: an env/exec failure is an INFRA outcome, not a public-repro verdict.
      sourcePolicy: "infra",
      state: repro.reason.includes("env") ? "env_prep_failed" : "execution_failed",
      ...(repro.sampleStdoutTail !== undefined
        ? { stdoutTail: boundTail(repro.sampleStdoutTail, 600) }
        : {}),
      ...(repro.sampleStderrTail !== undefined
        ? { stderrTail: boundTail(repro.sampleStderrTail, 600) }
        : {}),
    },
  ]
}

export const buildIntakeLlmEvidencePacket = (input: IntakeLlmEvidenceInput): LlmEvidencePacket => {
  const issueReproSeed = extractIssueReproSeed(input.problemStatement)
  const verificationTarget = verificationTargetFromPlan(input.verificationPlan)
  const missingEvidence: MissingEvidenceFact[] = [
    ...(input.faultEvidence === undefined
      ? [{ kind: "fault_evidence", reason: "no_fault_evidence_packet" }]
      : []),
    ...(input.verificationPlan === undefined
      ? [{ kind: "verification_plan", reason: "no_verification_plan" }]
      : []),
    ...(issueReproSeed === undefined
      ? [{ kind: "public_mwe_seed", reason: "no_public_issue_mwe_seed" }]
      : []),
    ...(input.reproTest === undefined
      ? [{ kind: "public_mwe_base", reason: "public_mwe_base_not_attempted" }]
      : []),
  ]
  return cleanPacket({
    stage: "intake",
    instanceIdHash: opaqueInstanceIdHash(input.problemStatement),
    evidenceRevision: "intake-v2",
    question: "Which allowed evidence source should be collected next?",
    allowedActions: [
      "run_public_mwe_base",
      "discover_public_regression",
      "inspect_owner_slice",
      "generate_candidate",
    ],
    forbiddenSources: [
      "hidden_tests",
      "gold_patch",
      "official_harness_results",
      "contaminated_case_labels",
    ],
    publicIssueFacts: describeIssueFacts(input.problemStatement, "intake"),
    ownerEvidence: ownerEvidenceFromFaultEvidence(input),
    proofReceipts: [
      {
        source: "public_mwe",
        // B8: a not-yet-executed issue-derived seed is public-issue provenance.
        sourcePolicy: "public_issue",
        state: "static_only",
        ...(issueReproSeed !== undefined
          ? { command: `issue-seed:${issueReproSeed.provenance}` }
          : {}),
      },
      ...reproReceipts(input.reproTest),
    ],
    contractFacts: [],
    staticFacts: [
      {
        kind: "fault_evidence",
        value:
          input.faultEvidence === undefined
            ? "missing"
            : `partial=${input.faultEvidence.partial}; truncated=${input.faultEvidence.truncated}`,
      },
      { kind: "localize_candidates", value: fmtList(input.localizeCandidates) },
    ],
    ...(verificationTarget !== undefined ? { verificationTarget } : {}),
    missingEvidence,
  })
}

/* ------------------------------------------------------------------ */
/* Candidate generation packet (SHARED — one helper, both drivers)     */
/* ------------------------------------------------------------------ */

/** Bounded number of validated repro scripts rendered into the generation packet. */
const VALIDATED_REPRO_SCRIPT_CAP = 2

export interface SelectionGenerationPacketInput {
  readonly problemStatement: string
  readonly ownerEvidence: readonly OwnerEvidenceFact[]
  readonly contracts: readonly ContractFact[]
  readonly verificationTarget?: VerificationTargetFact
  readonly reproCommand?: string
  readonly validatedReproScripts?: readonly string[]
  readonly existingTestExpectations?: readonly string[]
  readonly baseValidatedRed?: boolean
  readonly closureHint?: string
  readonly seed?: string
  readonly envCaveats?: readonly string[]
  readonly staticWitnessDiagnostics?: readonly StaticWitnessDiagnostic[]
}

const selectionGenerationMissingEvidence = (
  input: SelectionGenerationPacketInput,
): MissingEvidenceFact[] => [
  ...(input.reproCommand === undefined
    ? [{ kind: "public_repro", reason: "no_executable_public_repro_hint" }]
    : []),
  ...(input.verificationTarget === undefined
    ? [{ kind: "verification_target", reason: "no_verification_plan_available" }]
    : []),
  ...ownerSliceMissingEvidence(input.ownerEvidence),
]

const selectionGenerationProofReceipts = (
  input: SelectionGenerationPacketInput,
): ProofReceiptFact[] =>
  input.reproCommand === undefined
    ? []
    : [
        {
          source: "public_mwe",
          sourcePolicy: "public_repro",
          state: input.baseValidatedRed === true ? "base_red" : "static_only",
          command: input.reproCommand,
          ...(input.baseValidatedRed !== undefined
            ? { baseValidatedRed: input.baseValidatedRed }
            : {}),
        },
      ]

const nonEmptyValidatedReproScripts = (input: SelectionGenerationPacketInput): string[] =>
  (input.validatedReproScripts ?? [])
    .map((source) => source.trim())
    .filter((source) => source !== "")

const validatedPublicReproFacts = (input: SelectionGenerationPacketInput): StaticFact[] => {
  const scripts = nonEmptyValidatedReproScripts(input)
  const note =
    scripts.length > 0
      ? [
          {
            kind: "validated_public_repro_note",
            value:
              "Scripts below reproduce the issue on the UNPATCHED tree — they reflect the bug's observable behavior. Use them to understand the ROOT CAUSE; a correct fix should make them pass cleanly (all assertions green / exit 0), but fix the root cause rather than contorting the patch to satisfy any single script.",
          },
        ]
      : []
  const rendered = scripts
    .filter((_, i) => i < VALIDATED_REPRO_SCRIPT_CAP)
    .map((source, i) => ({
      kind: "validated_public_repro",
      value: `script ${i + 1}: ${boundHead(source, 1200)}`,
    }))
  const omitted = scripts.length - VALIDATED_REPRO_SCRIPT_CAP
  const omittedFact =
    omitted > 0
      ? [
          {
            kind: "validated_public_repro_omitted",
            value: `Omitted ${omitted} additional validated reproduction script(s) to keep the prompt compact.`,
          },
        ]
      : []
  return [...note, ...rendered, ...omittedFact]
}

const existingOwnerTestExpectationFacts = (input: SelectionGenerationPacketInput): StaticFact[] => {
  const expectations = (input.existingTestExpectations ?? [])
    .map((fact) => fact.trim())
    .filter((fact) => fact !== "")
  if (expectations.length === 0) return []
  return [
    {
      kind: "existing_owner_test_expectation_note",
      value:
        "Existing repo tests below are PUBLIC source-of-truth examples. Match their exact behavior and message literals before inventing a new interpretation.",
    },
    ...expectations.map((fact, i) => ({
      kind: "existing_owner_test_expectation",
      value: `expectation ${i + 1}: ${boundHead(fact, 240)}`,
    })),
  ]
}

const selectionGenerationStaticFacts = (
  input: SelectionGenerationPacketInput,
  diagnostics: ReturnType<typeof staticWitnessDiagnosticsFacts>,
): StaticFact[] => [
  ...validatedPublicReproFacts(input),
  ...existingOwnerTestExpectationFacts(input),
  ...diagnostics.staticFacts,
  ...(input.seed !== undefined && input.seed.trim() !== ""
    ? [{ kind: "diversity_seed", value: boundHead(input.seed, 400) }]
    : []),
]

const selectionGenerationPublicIssueFacts = (input: SelectionGenerationPacketInput): string[] => [
  ...describeIssueFacts(input.problemStatement, "candidate_generation"),
  ...(input.closureHint !== undefined && input.closureHint.trim() !== ""
    ? [`co-change hint: ${boundHead(input.closureHint, 400)}`]
    : []),
  ...(input.envCaveats ?? []).map((c) => `env caveat: ${c}`),
]

/**
 * The single shared candidate_generation packet builder. SELF-CONTAINED: it
 * carries actual public issue facts + the active proof target, so it never
 * points back to ambient prompt text. Returns the rendered prompt string.
 */
export const buildSelectionGenerationLlmEvidencePacket = (
  input: SelectionGenerationPacketInput,
): LlmEvidencePacket => {
  assertEvidenceTextBlind("candidate_generation", [
    input.problemStatement,
    input.reproCommand,
    input.closureHint,
    input.seed,
    ...(input.envCaveats ?? []),
    ...(input.validatedReproScripts ?? []),
    ...(input.existingTestExpectations ?? []),
  ])
  const missingEvidence = selectionGenerationMissingEvidence(input)
  const staticWitnessDiagnostics = staticWitnessDiagnosticsFacts(input.staticWitnessDiagnostics)
  return cleanPacket({
    stage: "candidate_generation",
    instanceIdHash: opaqueInstanceIdHash(input.problemStatement),
    evidenceRevision: "selection-generation-v3",
    question:
      "Produce one minimal candidate patch that satisfies the active proof target against the bounded owner surface below.",
    allowedActions: [
      "edit_candidate_sandbox_only",
      "inspect_named_owner_files",
      "produce_minimal_patch",
    ],
    forbiddenSources: [
      "hidden_tests",
      "gold_patch",
      "official_harness_results",
      "benchmark_case_tables",
      "broad_multifile_drift_without_public_evidence",
    ],
    publicIssueFacts: selectionGenerationPublicIssueFacts(input),
    ownerEvidence: input.ownerEvidence,
    proofReceipts: selectionGenerationProofReceipts(input),
    contractFacts: input.contracts,
    staticFacts: selectionGenerationStaticFacts(input, staticWitnessDiagnostics),
    ...(input.verificationTarget !== undefined
      ? { verificationTarget: input.verificationTarget }
      : {}),
    missingEvidence: [...missingEvidence, ...staticWitnessDiagnostics.missingEvidence],
  })
}

export interface SelectionGenerationPromptInput
  extends Omit<SelectionGenerationPacketInput, "baseValidatedRed"> {
  readonly baseValidatedRed: boolean | null
  readonly recordLlmEvidencePacket?: (packet: LlmEvidencePacket) => void
}

/**
 * Shared clean generation prompt SSOT. `baseValidatedRed=null` means no repro
 * authority exists in this posture, so the field is omitted instead of being
 * coerced into a false hard gate.
 */
export const buildSelectionGenerationPrompt = (input: SelectionGenerationPromptInput): string => {
  const packet = buildSelectionGenerationLlmEvidencePacket({
    problemStatement: input.problemStatement,
    ownerEvidence: input.ownerEvidence,
    contracts: input.contracts,
    ...(input.baseValidatedRed !== null ? { baseValidatedRed: input.baseValidatedRed } : {}),
    ...(input.verificationTarget !== undefined
      ? { verificationTarget: input.verificationTarget }
      : {}),
    ...(input.reproCommand !== undefined ? { reproCommand: input.reproCommand } : {}),
    ...(input.validatedReproScripts !== undefined && input.validatedReproScripts.length > 0
      ? { validatedReproScripts: input.validatedReproScripts }
      : {}),
    ...(input.existingTestExpectations !== undefined && input.existingTestExpectations.length > 0
      ? { existingTestExpectations: input.existingTestExpectations }
      : {}),
    ...(input.closureHint !== undefined ? { closureHint: input.closureHint } : {}),
    ...(input.envCaveats !== undefined && input.envCaveats.length > 0
      ? { envCaveats: input.envCaveats }
      : {}),
    ...(input.staticWitnessDiagnostics !== undefined && input.staticWitnessDiagnostics.length > 0
      ? { staticWitnessDiagnostics: input.staticWitnessDiagnostics }
      : {}),
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
  })
  input.recordLlmEvidencePacket?.(packet)
  return renderLlmEvidencePacket(packet)
}

/* ------------------------------------------------------------------ */
/* Candidate review packet (runtime risk screen, shadow/research only)  */
/* ------------------------------------------------------------------ */

export interface CandidateReviewPacketInput {
  readonly problemStatement: string
  readonly candidatePatchHash: string
  readonly candidateFiles: readonly string[]
  readonly ownerEvidence: readonly OwnerEvidenceFact[]
}

/**
 * LEGACY-NAMED stage. This is the PRE-proof expansion risk screen for
 * candidate 0 ("should the selector expand?"), not a post-exec correctness
 * review. It carries no submit authority; the deterministic selector still
 * decides.
 */
export const buildCandidateReviewLlmEvidencePacket = (
  input: CandidateReviewPacketInput,
): LlmEvidencePacket =>
  cleanPacket({
    stage: "candidate_review",
    instanceIdHash: opaqueInstanceIdHash(input.problemStatement),
    evidenceRevision: "risk-gate-v2",
    candidatePatchHash: input.candidatePatchHash,
    question:
      "Should the outer selector expand beyond candidate 0, or is the current patch already low-risk enough to stop?",
    allowedActions: ["expand", "do_not_expand"],
    forbiddenSources: [
      "hidden_tests",
      "gold_patch",
      "official_harness_results",
      "benchmark_case_tables",
    ],
    publicIssueFacts: describeIssueFacts(input.problemStatement, "candidate_review"),
    ownerEvidence: input.ownerEvidence,
    proofReceipts: [],
    contractFacts: [],
    staticFacts: [
      { kind: "stage_scope", value: "This stage does not judge correctness or select a winner." },
      {
        kind: "expand_when",
        value:
          "Expand when the patch may miss explicit issue conditions, may implement only a surfaced symptom, may overfit a public example, changes behavior without clear evidence, or you are unsure.",
      },
      {
        kind: "candidate_touched_files",
        value: input.candidateFiles.length > 0 ? input.candidateFiles.join(", ") : "<none>",
      },
    ],
    missingEvidence: [
      {
        kind: "executed_public_proof",
        reason: "no_executed_public_proof_receipts_attached_to_risk_gate",
      },
    ],
  })

/* ------------------------------------------------------------------ */
/* Candidate post-review packet (executed-proof diagnosis)             */
/* ------------------------------------------------------------------ */

export interface CandidatePostReviewPacketInput {
  readonly problemStatement: string
  readonly candidatePatchHash: string
  readonly ownerEvidence: readonly OwnerEvidenceFact[]
  readonly proofReceipts: readonly ProofReceiptFact[]
  readonly contracts: readonly ContractFact[]
  readonly verificationTarget?: VerificationTargetFact
  /** SOURCE-ONLY candidate edit surface (B7). */
  readonly candidateEditSurface?: CandidateEditSurfaceFact
  readonly staticWitnessDiagnostics?: readonly StaticWitnessDiagnostic[]
  readonly missingEvidence?: readonly MissingEvidenceFact[]
}

export const buildCandidatePostReviewLlmEvidencePacket = (
  input: CandidatePostReviewPacketInput,
): LlmEvidencePacket => {
  const staticWitnessDiagnostics = staticWitnessDiagnosticsFacts(input.staticWitnessDiagnostics)
  return cleanPacket({
    stage: "candidate_post_review",
    instanceIdHash: opaqueInstanceIdHash(input.problemStatement),
    evidenceRevision: "candidate-post-review-v1",
    candidatePatchHash: input.candidatePatchHash,
    question:
      "Diagnose the executed candidate using only these proof receipts, then identify the smallest bounded repair that preserves any stronger public or structural coverage already present.",
    allowedActions: [
      "diagnose_executed_candidate",
      "identify_missing_public_proof",
      "preserve_supported_structural_coverage",
    ],
    forbiddenSources: [
      "hidden_tests",
      "gold_patch",
      "official_harness_results",
      "benchmark_case_tables",
      "selection_override",
    ],
    publicIssueFacts: describeIssueFacts(input.problemStatement, "candidate_post_review"),
    ownerEvidence: input.ownerEvidence,
    proofReceipts: input.proofReceipts,
    contractFacts: input.contracts,
    staticFacts: [
      {
        kind: "review_scope",
        value:
          "Post-exec diagnosis only: use executed proof receipts and deterministic hard reasons to decide what the next bounded repair must preserve or fix.",
      },
      ...staticWitnessDiagnostics.staticFacts,
    ],
    ...(input.verificationTarget !== undefined
      ? { verificationTarget: input.verificationTarget }
      : {}),
    ...(input.candidateEditSurface !== undefined
      ? { candidateEditSurface: input.candidateEditSurface }
      : {}),
    missingEvidence: [
      ...(input.missingEvidence ??
        (input.proofReceipts.some(
          (receipt) => receipt.state !== "not_run" && receipt.state !== "static_only",
        )
          ? []
          : [
              {
                kind: "executed_public_proof",
                reason: "no_executed_public_proof_receipts_attached_to_post_exec_review",
              },
            ])),
      // B2: a missing owner slice is VISIBLE here, mirroring candidate_generation.
      ...ownerSliceMissingEvidence(input.ownerEvidence),
      ...staticWitnessDiagnostics.missingEvidence,
    ],
  })
}

/* ------------------------------------------------------------------ */
/* Repair seed packet (SHARED)                                         */
/* ------------------------------------------------------------------ */

export interface RepairSeedPacketInput {
  readonly problemStatement: string
  readonly candidatePatchHash: string
  readonly ownerEvidence: readonly OwnerEvidenceFact[]
  readonly proofReceipts: readonly ProofReceiptFact[]
  readonly contracts: readonly ContractFact[]
  /** Deterministic repair instruction text (bounded) assembled by the selector. */
  readonly repairGuidance?: string
  readonly verificationTarget?: VerificationTargetFact
  /** SOURCE-ONLY candidate edit surface (B7). */
  readonly candidateEditSurface?: CandidateEditSurfaceFact
  readonly missingEvidence?: readonly MissingEvidenceFact[]
}

/**
 * The single post-exec LLM action in the v4 minimum: turn a deterministic
 * proof/contract failure into one bounded next candidate. SELF-CONTAINED (real
 * issue facts) and instanceIdHash is the SAME opaque problem-statement hash as
 * every other stage; candidate identity lives in `candidatePatchHash`.
 */
export const buildRepairSeedLlmEvidencePacket = (
  input: RepairSeedPacketInput,
): LlmEvidencePacket => {
  assertEvidenceTextBlind("repair_seed", [input.problemStatement, input.repairGuidance])
  return cleanPacket({
    stage: "repair_seed",
    instanceIdHash: opaqueInstanceIdHash(input.problemStatement),
    evidenceRevision: "selector-repair-v2",
    candidatePatchHash: input.candidatePatchHash,
    question:
      "Generate a bounded repair instruction for the next candidate that satisfies the named public proof.",
    allowedActions: [
      "bounded_repair_only",
      "preserve_stronger_structural_coverage",
      "satisfy_named_public_proof",
    ],
    forbiddenSources: [
      "hidden_tests",
      "gold_patch",
      "official_harness_results",
      "benchmark_case_tables",
      "try_harder_generic_retry",
    ],
    publicIssueFacts: describeIssueFacts(input.problemStatement, "repair_seed"),
    ownerEvidence: input.ownerEvidence,
    proofReceipts: input.proofReceipts,
    contractFacts: input.contracts,
    staticFacts:
      input.repairGuidance !== undefined && input.repairGuidance.trim() !== ""
        ? [{ kind: "repair_guidance", value: boundHead(input.repairGuidance, 1800) }]
        : [],
    ...(input.verificationTarget !== undefined
      ? { verificationTarget: input.verificationTarget }
      : {}),
    ...(input.candidateEditSurface !== undefined
      ? { candidateEditSurface: input.candidateEditSurface }
      : {}),
    missingEvidence: [
      ...(input.missingEvidence ??
        (input.proofReceipts.every((r) => r.state !== "candidate_red" && r.state !== "base_red")
          ? [
              {
                kind: "executed_public_proof",
                reason: "no_positive_executed_public_proof_attached",
              },
            ]
          : [])),
      // B2: a missing owner slice is VISIBLE here, mirroring candidate_generation.
      ...ownerSliceMissingEvidence(input.ownerEvidence),
    ],
  })
}

/* ------------------------------------------------------------------ */
/* Selection explanation packet (report-only RCA)                      */
/* ------------------------------------------------------------------ */

export interface SelectionExplanationCandidateInput {
  readonly id: string
  readonly files: readonly string[]
  readonly touchedSymbols?: readonly string[]
  readonly admissible: boolean
  readonly reasons: readonly string[]
  readonly proofState?: SelectionProofState
  readonly proofSource?: SelectionProofSource
  readonly requiredContractsSatisfied?: number
  readonly contractsSatisfied?: number
}

export interface SelectionExplanationProofSummaryInput {
  readonly proofState: SelectionProofState
  readonly proofSource: SelectionProofSource
  readonly proofRequiredMissing: boolean
  readonly contractOnlySubmitted: boolean
  readonly contractOnlyBlocked: boolean
  readonly publicMweState?: MweProofState
  readonly publicRegressionState?: PublicRegressionProofState
  readonly reproConsensusState?: ReproConsensusProofState
  /** B5 — executed module-smoke (public issue-smoke) HARD-gate RESULT for the
   *  focus candidate (green/red). Absent ⇒ the smoke gate did not run. */
  readonly moduleSmokeState?: "green" | "red"
  readonly repairOnlyCandidates: number
  readonly submittedCandidateProof: boolean
}

export interface SelectionExplanationLlmEvidenceInput {
  readonly problemStatement: string
  readonly ownerFiles: readonly string[]
  readonly winnerId: string | null
  readonly noWinnerReason?: string
  readonly proofRequired?: boolean
  readonly proofSummary?: SelectionExplanationProofSummaryInput
  readonly candidates: readonly SelectionExplanationCandidateInput[]
  readonly staticWitnessDiagnostics?: readonly StaticWitnessDiagnostic[]
}

const proofSummaryReceipts = (
  summary: SelectionExplanationProofSummaryInput | undefined,
): ProofReceiptFact[] => {
  if (summary === undefined)
    return [{ source: "selection", sourcePolicy: "static", state: "not_run" }]
  const publicMweReceiptState = (
    state: MweProofState | undefined,
  ): ProofReceiptState | undefined => {
    switch (state) {
      case undefined:
        return undefined
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
      case "not_found":
        return "not_run"
    }
  }
  const publicRegressionReceiptState = (
    state: PublicRegressionProofState | undefined,
  ): ProofReceiptState | undefined => {
    switch (state) {
      case undefined:
        return undefined
      case "candidate_red":
        return "candidate_red"
      case "safety_green":
        return "candidate_green"
      case "execution_failed":
        return "execution_failed"
      case "coverage_capped":
        return "static_only"
      case "not_available":
      case "base_not_green":
        return "not_run"
    }
  }
  const reproConsensusReceiptState = (
    state: ReproConsensusProofState | undefined,
  ): ProofReceiptState | undefined => {
    switch (state) {
      case undefined:
        return undefined
      case "base_red_candidate_green":
        return "candidate_green"
      case "base_red_candidate_red":
        return "candidate_red"
      case "execution_failed":
        return "execution_failed"
      case "false_negative_suspected":
        return "static_only"
      case "not_available":
        return "not_run"
    }
  }
  // B8: each report receipt carries an explicit typed source policy.
  const withPolicy = (source: string, state: ProofReceiptState): ProofReceiptFact => {
    const policy = sourcePolicyOf(source)
    return {
      source,
      ...(policy !== undefined ? { sourcePolicy: policy } : {}),
      state,
    }
  }
  return [
    ...(() => {
      const state = publicMweReceiptState(summary.publicMweState)
      return state === undefined ? [] : [withPolicy("public_mwe", state)]
    })(),
    ...(() => {
      const state = publicRegressionReceiptState(summary.publicRegressionState)
      return state === undefined ? [] : [withPolicy("discovered_regression", state)]
    })(),
    ...(() => {
      const state = reproConsensusReceiptState(summary.reproConsensusState)
      return state === undefined ? [] : [withPolicy("repro_consensus", state)]
    })(),
    // B5 — the executed module-smoke RESULT as a proof receipt the model sees.
    // `ownerTestResultReceipt` enforces `cmdWithheld:true` (RESULT ONLY, C3
    // fence): the LLM/router learns green/red, never the smoke command/selector.
    ...(summary.moduleSmokeState === undefined
      ? []
      : [ownerTestResultReceipt({ kind: "module_smoke", result: summary.moduleSmokeState })]),
  ]
}

export const buildSelectionExplanationPacket = (
  input: SelectionExplanationLlmEvidenceInput,
): LlmEvidencePacket => {
  const staticWitnessDiagnostics = staticWitnessDiagnosticsFacts(input.staticWitnessDiagnostics)
  const focusCandidate =
    input.winnerId === null
      ? undefined
      : input.candidates.find((candidate) => candidate.id === input.winnerId)
  const missingEvidence: MissingEvidenceFact[] = [
    ...(input.winnerId === null ? [{ kind: "winner", reason: "no_selected_candidate" }] : []),
    ...(input.proofSummary?.proofRequiredMissing === true
      ? [{ kind: "executed_public_proof", reason: "no_positive_executed_public_proof" }]
      : []),
    ...(input.proofSummary?.proofState === "infra_blocked"
      ? [{ kind: "public_proof", reason: "public_proof_infra_blocked" }]
      : []),
    ...staticWitnessDiagnostics.missingEvidence,
  ]
  return cleanPacket({
    stage: "selection_explanation",
    instanceIdHash: opaqueInstanceIdHash(input.problemStatement),
    evidenceRevision: "selection-explanation-v2",
    question:
      "Explain the deterministic selection outcome and the remaining missing public evidence.",
    allowedActions: [
      "explain_selection_outcome",
      "identify_missing_public_evidence",
      "separate_infra_from_candidate_failure",
    ],
    forbiddenSources: [
      "hidden_tests",
      "gold_patch",
      "official_harness_results",
      "benchmark_case_tables",
      "selection_override",
    ],
    publicIssueFacts: describeIssueFacts(input.problemStatement, "selection_explanation"),
    ownerEvidence: input.ownerFiles.map((file) => ({
      file,
      symbols: [],
      provenance: "selection-owner",
    })),
    proofReceipts: proofSummaryReceipts(input.proofSummary),
    contractFacts: input.candidates.map((c) => ({
      contractId: `candidate:${c.id}`,
      authority: `required=${c.requiredContractsSatisfied ?? 0}; contracts=${c.contractsSatisfied ?? 0}; proof=${c.proofState ?? "unknown"}`,
      satisfied: c.admissible,
    })),
    staticFacts: [
      { kind: "selected_candidate", value: input.winnerId ?? "<none>" },
      { kind: "proof_required", value: String(input.proofRequired === true) },
      ...(input.proofSummary !== undefined
        ? [
            {
              kind: "proof_gates",
              value: `state=${input.proofSummary.proofState}; source=${input.proofSummary.proofSource}; contractOnlySubmitted=${input.proofSummary.contractOnlySubmitted}; repairOnly=${input.proofSummary.repairOnlyCandidates}`,
            },
          ]
        : []),
      ...(input.noWinnerReason !== undefined
        ? [{ kind: "no_winner_reason", value: input.noWinnerReason }]
        : []),
      ...staticWitnessDiagnostics.staticFacts,
      ...input.candidates.map((c) => ({
        kind: `candidate:${c.id}`,
        value: `admissible=${c.admissible}; files=${fmtList(c.files)}; reasons=${fmtList(c.reasons)}`,
      })),
    ],
    ...(focusCandidate !== undefined
      ? {
          candidateEditSurface: {
            touchedFiles: focusCandidate.files,
            touchedSymbols: [...(focusCandidate.touchedSymbols ?? [])],
          },
        }
      : {}),
    missingEvidence,
  })
}

/** The phase-DECISION question the router actually asks. Mirrors the router
 *  instruction ("choose the single best next PHASE") so the packet contract and
 *  the surrounding prompt agree. */
export const PHASE_ROUTING_QUESTION =
  "Choose the single best NEXT PHASE for this bounded fix controller, given the bounded evidence below. You are ROUTING (selecting a phase), not explaining a past outcome and not submitting."

/**
 * A10 — re-contract an evidence packet for the adaptive PHASE ROUTER. The router
 * consumes the `selection_explanation` evidence BODY but asks a phase-DECISION
 * question, so the original packet's `stage:"selection_explanation"` /
 * `question:"Explain…"` / `allowedActions:["explain_…"]` are a STALE, misleading
 * contract for that consumer. This rewrites exactly those three fields to the
 * routing contract — `stage:"phase_routing"`, the phase-decision
 * {@link PHASE_ROUTING_QUESTION}, and the closed routing action menu (`routingActions`,
 * supplied by the caller so this module need not couple to the router's action
 * union) — while preserving every EVIDENCE field (issue facts, owner evidence,
 * proof receipts, etc.) byte-for-byte. The result is re-cleaned, so blindness
 * still holds. The original (report-RCA) packet is untouched: callers build a
 * separate packet for the report.
 */
export const toPhaseRoutingContract = (
  packet: LlmEvidencePacket,
  routingActions: readonly string[],
): LlmEvidencePacket =>
  cleanPacket({
    ...packet,
    stage: "phase_routing",
    question: PHASE_ROUTING_QUESTION,
    allowedActions: routingActions,
  })
