import { buildRepairContext } from "@/runner/batch/eval/repair/context"
import {
  cleanPacket,
  opaqueInstanceIdHash,
  renderLlmEvidencePacket,
  type LlmEvidencePacket,
  type MissingEvidenceFact,
  type OwnerEvidenceFact,
  type ProofReceiptFact,
  type ProofReceiptState,
  type StaticFact,
} from "@/runner/batch/eval/llm-evidence-packet"
import type { BuildRepairContextArgs } from "@/runner/batch/eval/repair/types"
import type { RepairValidationSource } from "@/runner/batch/eval/repair/types"
import { filesFromUnifiedDiff } from "@/shared"

const bounded = (s: string | undefined, n = 1200): string => {
  const v = s?.trim() ?? ""
  if (v === "") return ""
  return v.length > n ? `${v.slice(0, n)}\n... <${v.length - n} bytes truncated>` : v
}

const proofStateOf = (source: RepairValidationSource | undefined, exitCode: number | undefined): ProofReceiptState => {
  if (source === undefined || source === "none") return "not_run"
  if (exitCode === undefined) return "not_run"
  return exitCode === 0 ? "candidate_green" : "candidate_red"
}

const proofSourceOf = (source: RepairValidationSource | undefined): string =>
  source === "primary_rail"
    ? "primary_rail"
    : source === "verify_cmd"
      ? "verify_cmd"
      : source === "repro"
        ? "public_repro"
        : "validation_gate"

const ownerEvidenceOf = (siblingOwners: readonly string[] | undefined): readonly OwnerEvidenceFact[] =>
  [...new Set(siblingOwners ?? [])].map((file) => ({
    file,
    symbols: [],
    provenance: "repair-sibling-owner",
  }))

const proofReceiptsOf = (args: BuildRepairContextArgs): readonly ProofReceiptFact[] => {
  if (args.validationSource === undefined || args.validationSource === "none") return []
  const receipt: ProofReceiptFact = {
    source: proofSourceOf(args.validationSource),
    state: proofStateOf(args.validationSource, args.validationExitCode),
    ...(args.validationCmd !== undefined && args.validationCmd !== ""
      ? { command: args.validationCmd }
      : {}),
  }
  return [receipt]
}

const staticFactsOf = (args: BuildRepairContextArgs): readonly StaticFact[] => {
  const touchedFiles = filesFromUnifiedDiff(args.cumulativeDiff)
  return [
    { kind: "repair_round", value: String(args.round) },
    {
      kind: "cumulative_patch_files",
      value: touchedFiles.length > 0 ? touchedFiles.join(", ") : "<none>",
    },
    ...(args.cumulativeDiff.trim() !== ""
      ? [{ kind: "cumulative_patch_excerpt", value: bounded(args.cumulativeDiff, 1600) }]
      : []),
    ...(args.failTail.trim() !== ""
      ? [{ kind: "validation_fail_tail", value: bounded(args.failTail, 1000) }]
      : []),
    ...(args.validationSource !== undefined
      ? [{ kind: "validation_source", value: args.validationSource }]
      : []),
    ...(args.predicateSummary !== undefined && args.predicateSummary.trim() !== ""
      ? [{ kind: "typed_predicate_summary", value: bounded(args.predicateSummary, 600) }]
      : []),
  ]
}

const missingEvidenceOf = (args: BuildRepairContextArgs): readonly MissingEvidenceFact[] => [
  ...(args.validationSource === undefined || args.validationSource === "none"
    ? [{ kind: "verification_command", reason: "no_runnable_validation_gate_captured" }]
    : []),
  ...(args.validationSource !== undefined &&
  args.validationSource !== "none" &&
  (args.validationCmd === undefined || args.validationCmd.trim() === "")
    ? [{ kind: "verification_command", reason: "validation_gate_missing_command_text" }]
    : []),
]

export const buildRepairRoundLlmEvidencePacket = (
  args: BuildRepairContextArgs,
): LlmEvidencePacket =>
  cleanPacket({
    stage: "repair_seed",
    instanceIdHash: opaqueInstanceIdHash(args.problem),
    evidenceRevision: "repair-round-v1",
    question:
      "Revise the existing cumulative patch so the named validation gate passes without discarding already-correct work.",
    allowedActions: [
      "repair_existing_patch_only",
      "preserve_working_edits",
      "satisfy_named_validation_gate",
    ],
    forbiddenSources: [
      "hidden_tests",
      "gold_patch",
      "official_harness_results",
      "benchmark_case_tables",
      "generic_retry_without_addressing_failure",
    ],
    publicIssueFacts: [
      `issue summary: ${bounded(args.problem, 500)}`,
      ...(args.siblingOwners !== undefined && args.siblingOwners.length > 0
        ? [`co_change_sites: ${[...new Set(args.siblingOwners)].join(", ")}`]
        : []),
    ],
    ownerEvidence: ownerEvidenceOf(args.siblingOwners),
    proofReceipts: proofReceiptsOf(args),
    contractFacts: [],
    staticFacts: staticFactsOf(args),
    missingEvidence: missingEvidenceOf(args),
  })

export const buildRepairRoundSeedMessage = (
  args: BuildRepairContextArgs,
): { readonly packet: LlmEvidencePacket; readonly seedMsg: string } => {
  const packet = buildRepairRoundLlmEvidencePacket(args)
  return {
    packet,
    seedMsg: `${renderLlmEvidencePacket(packet)}\n\n${buildRepairContext(args)}`,
  }
}
