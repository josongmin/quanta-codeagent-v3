import { createHash } from "node:crypto"
import { extractIssueHint } from "@/agent/issue-hint"
import type { FaultEvidencePacket } from "@/agent/fault-evidence"
import { extractIssueReproSeed } from "@/agent/verification-plan"
import type { VerificationPlan } from "@/agent/verification-plan"
import { normalizePublicIssueText } from "@/shared"

export type LlmEvidencePacketStage =
  | "intake"
  | "candidate_generation"
  | "candidate_review"
  | "repair_seed"
  | "selection_explanation"

export interface LlmEvidencePacket {
  readonly stage: LlmEvidencePacketStage
  readonly instanceIdHash: string
  readonly evidenceRevision: string
  readonly candidatePatchHash?: string
  readonly question: string
  readonly allowedActions: readonly string[]
  readonly forbiddenSources: readonly string[]
  readonly publicIssueFacts: readonly string[]
  readonly ownerEvidence: readonly string[]
  readonly proofReceipts: readonly string[]
  readonly contractFacts: readonly string[]
  readonly staticFacts: readonly string[]
  readonly missingEvidence: readonly string[]
}

export interface LlmEvidenceArtifacts {
  readonly intake?: LlmEvidencePacket
  readonly selectionExplanation?: LlmEvidencePacket
}

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

export interface SelectionExplanationCandidateInput {
  readonly id: string
  readonly files: readonly string[]
  readonly admissible: boolean
  readonly reasons: readonly string[]
  readonly proofState?: string
  readonly proofSource?: string
  readonly requiredContractsSatisfied?: number
  readonly contractsSatisfied?: number
}

export interface SelectionExplanationProofSummaryInput {
  readonly proofState: string
  readonly proofSource: string
  readonly proofRequiredMissing: boolean
  readonly contractOnlySubmitted: boolean
  readonly contractOnlyBlocked: boolean
  readonly publicMweState?: string
  readonly publicRegressionState?: string
  readonly reproConsensusState?: string
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
}

const uniqueLines = (values: readonly string[]): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of values) {
    const value = raw.trim()
    if (value === "" || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

const cleanPacket = (packet: LlmEvidencePacket): LlmEvidencePacket => ({
  ...packet,
  allowedActions: uniqueLines(packet.allowedActions),
  forbiddenSources: uniqueLines(packet.forbiddenSources),
  publicIssueFacts: uniqueLines(packet.publicIssueFacts),
  ownerEvidence: uniqueLines(packet.ownerEvidence),
  proofReceipts: uniqueLines(packet.proofReceipts),
  contractFacts: uniqueLines(packet.contractFacts),
  staticFacts: uniqueLines(packet.staticFacts),
  missingEvidence: uniqueLines(packet.missingEvidence),
})

export const stableHash = (text: string): string =>
  createHash("sha256").update(text).digest("hex").slice(0, 16)

export const opaqueInstanceIdHash = (problemStatement: string): string =>
  stableHash(problemStatement.trim())

export const candidatePatchHash = (patch: string): string => stableHash(patch)

const firstNonEmptyLine = (text: string): string | undefined =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)

const bounded = (text: string, max = 220): string =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`

const fmtList = (values: readonly string[], empty = "<none>"): string =>
  values.length === 0 ? empty : values.join(", ")

const describeVerificationPlan = (plan: VerificationPlan | undefined): string[] => {
  if (plan === undefined) return ["verification plan: missing"]
  const lines = [
    `verification plan: baseValidatedRed=${plan.baseValidatedRed}; primaryRail=${plan.primaryRail?.kind ?? "none"}`,
  ]
  for (const [i, step] of plan.required.entries()) {
    lines.push(
      `required[${i}]: kind=${step.kind}; authority=${step.authority ?? "none"}; successPredicate=${step.successPredicate?.type ?? "none"}; cmd=${step.cmd}`,
    )
  }
  for (const [i, step] of plan.optional.entries()) {
    lines.push(`optional[${i}]: kind=${step.kind}; cmd=${step.cmd}`)
  }
  return lines
}

const describeReproStatus = (repro: IntakeReproTelemetry | undefined): string[] => {
  if (repro === undefined) return ["public MWE / repro install: not attempted"]
  if (repro.installed) {
    return [
      `public MWE / repro install: installed path=${repro.path}; samples=${repro.samples}; reproduced=${repro.reproducedCount}`,
    ]
  }
  return [
    `public MWE / repro install: unavailable reason=${repro.reason}; samples=${repro.samples ?? 0}; reproduced=${repro.reproducedCount ?? 0}`,
    ...(repro.sampleOutcomes !== undefined && repro.sampleOutcomes.length > 0
      ? [`public MWE / repro sampleOutcomes: ${repro.sampleOutcomes.join(", ")}`]
      : []),
  ]
}

const describeIssueFacts = (problemStatement: string): string[] => {
  const normalized = normalizePublicIssueText(problemStatement)?.trim() ?? problemStatement.trim()
  const hint = extractIssueHint(problemStatement)
  return [
    `issue summary: ${bounded(firstNonEmptyLine(normalized) ?? "<empty issue text>")}`,
    `issue symbols: ${fmtList(hint.symbols)}`,
    `issue files: ${fmtList(hint.files)}`,
  ]
}

const describeOwnerEvidence = (args: {
  readonly faultEvidence?: FaultEvidencePacket
  readonly localizeCandidates: readonly string[]
}): string[] => {
  if (args.faultEvidence !== undefined) {
    return args.faultEvidence.candidates.map(
      (candidate, i) =>
        `owner[${i}]: ${candidate.file}; score=${candidate.score}; sources=${fmtList(candidate.sources)}; symbols=${fmtList(candidate.symbols)}`,
    )
  }
  return args.localizeCandidates.length === 0
    ? ["owner candidates: none"]
    : args.localizeCandidates.map((file, i) => `owner[${i}]: ${file}; provenance=localize-stage1`)
}

export const buildIntakeLlmEvidencePacket = (input: IntakeLlmEvidenceInput): LlmEvidencePacket => {
  const issueReproSeed = extractIssueReproSeed(input.problemStatement)
  const missingEvidence = [
    ...(input.faultEvidence === undefined ? ["no_fault_evidence_packet"] : []),
    ...(input.verificationPlan === undefined ? ["no_verification_plan"] : []),
    ...(issueReproSeed === undefined ? ["no_public_issue_mwe_seed"] : []),
    ...(input.reproTest === undefined ? ["public_mwe_base_not_attempted"] : []),
  ]
  return cleanPacket({
    stage: "intake",
    instanceIdHash: opaqueInstanceIdHash(input.problemStatement),
    evidenceRevision: "intake-v1",
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
    publicIssueFacts: describeIssueFacts(input.problemStatement),
    ownerEvidence: describeOwnerEvidence(input),
    proofReceipts: [
      issueReproSeed === undefined
        ? "public MWE: static_only missing from issue text"
        : `public MWE: static_only extracted from issue text (${issueReproSeed.provenance})`,
      ...describeReproStatus(input.reproTest),
    ],
    contractFacts: describeVerificationPlan(input.verificationPlan),
    staticFacts: [
      input.faultEvidence === undefined
        ? "fault evidence packet missing"
        : `fault evidence: partial=${input.faultEvidence.partial}; truncated=${input.faultEvidence.truncated}`,
      input.localizeCandidates.length === 0
        ? "localizeCandidates: none"
        : `localizeCandidates: ${input.localizeCandidates.join(", ")}`,
    ],
    missingEvidence,
  })
}

const proofSummaryLines = (
  summary: SelectionExplanationProofSummaryInput | undefined,
): readonly string[] => {
  if (summary === undefined) return ["proof summary: unavailable"]
  return [
    `proof summary: state=${summary.proofState}; source=${summary.proofSource}; submittedCandidateProof=${summary.submittedCandidateProof}`,
    `proof gates: proofRequiredMissing=${summary.proofRequiredMissing}; contractOnlySubmitted=${summary.contractOnlySubmitted}; contractOnlyBlocked=${summary.contractOnlyBlocked}; repairOnlyCandidates=${summary.repairOnlyCandidates}`,
    ...(summary.publicMweState !== undefined
      ? [`public MWE proof state: ${summary.publicMweState}`]
      : []),
    ...(summary.publicRegressionState !== undefined
      ? [`public regression proof state: ${summary.publicRegressionState}`]
      : []),
    ...(summary.reproConsensusState !== undefined
      ? [`repro consensus proof state: ${summary.reproConsensusState}`]
      : []),
  ]
}

const candidateExplanationLines = (
  candidates: readonly SelectionExplanationCandidateInput[],
): readonly string[] =>
  candidates.map(
    (candidate) =>
      `candidate ${candidate.id}: admissible=${candidate.admissible}; proofState=${candidate.proofState ?? "unknown"}; proofSource=${candidate.proofSource ?? "none"}; files=${fmtList(candidate.files)}; requiredContracts=${candidate.requiredContractsSatisfied ?? 0}; contracts=${candidate.contractsSatisfied ?? 0}; reasons=${fmtList(candidate.reasons)}`,
  )

export const buildSelectionExplanationPacket = (
  input: SelectionExplanationLlmEvidenceInput,
): LlmEvidencePacket => {
  const missingEvidence = [
    ...(input.winnerId === null ? ["no_selected_candidate"] : []),
    ...(input.proofSummary?.proofRequiredMissing === true
      ? ["no_positive_executed_public_proof"]
      : []),
    ...(input.proofSummary?.proofState === "infra_blocked" ? ["public_proof_infra_blocked"] : []),
  ]
  return cleanPacket({
    stage: "selection_explanation",
    instanceIdHash: opaqueInstanceIdHash(input.problemStatement),
    evidenceRevision: "selection-explanation-v1",
    question: "Explain the deterministic selection outcome and the remaining missing public evidence.",
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
    publicIssueFacts: describeIssueFacts(input.problemStatement),
    ownerEvidence: input.ownerFiles.map((file, i) => `owner[${i}]: ${file}`),
    proofReceipts: proofSummaryLines(input.proofSummary),
    contractFacts: candidateExplanationLines(input.candidates),
    staticFacts: [
      `selected candidate: ${input.winnerId ?? "<none>"}`,
      `proofRequired: ${input.proofRequired === true}`,
      ...(input.noWinnerReason !== undefined ? [`noWinnerReason: ${input.noWinnerReason}`] : []),
    ],
    missingEvidence,
  })
}

export const renderLlmEvidencePacket = (packet: LlmEvidencePacket): string =>
  [
    "## LLM Evidence Packet",
    "Use only the bounded packet below. Do not assume hidden tests, gold patches, benchmark labels, or undocumented authority.",
    "```json",
    JSON.stringify(cleanPacket(packet), null, 2),
    "```",
  ].join("\n")
