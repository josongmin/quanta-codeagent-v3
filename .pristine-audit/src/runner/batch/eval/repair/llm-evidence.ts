import { diffTouchedSymbols } from "@/runner/batch/eval/diff-touched-symbols"
import {
  assembleOwnerEvidence,
  type CandidateEditSurfaceFact,
  cleanPacket,
  type LlmEvidencePacket,
  type MissingEvidenceFact,
  type OwnerEvidenceFact,
  opaqueInstanceIdHash,
  ownerSliceMissingEvidence,
  ownerTestResultReceipt,
  type ProofReceiptFact,
  type ProofReceiptState,
  renderLlmEvidencePacket,
  type StaticFact,
} from "@/runner/batch/eval/llm-evidence-packet"
import { buildRepairContext } from "@/runner/batch/eval/repair/context"
import type {
  BuildRepairContextArgs,
  RepairReproOutcome,
  RepairValidationSource,
} from "@/runner/batch/eval/repair/types"
import { combinedFailureTailOf } from "@/runner/batch/eval/repair/types"
import { filesFromUnifiedDiff } from "@/shared"

const boundHeadMarker = (s: string | undefined, n = 1200): string => {
  const v = s?.trim() ?? ""
  if (v === "") return ""
  return v.length > n ? `${v.slice(0, n)}\n... <${v.length - n} bytes truncated>` : v
}

const boundTailMarker = (s: string | undefined, n = 1200): string => {
  const v = s?.trim() ?? ""
  if (v === "") return ""
  return v.length > n ? `... <${v.length - n} bytes truncated>\n${v.slice(-n)}` : v
}

/**
 * A3: an OS-reserved exit code means the command could not RUN — an infra/exec
 * failure, never a test-correctness verdict. POSIX-standard (not a benchmark
 * heuristic): 126 = found-but-not-executable, 127 = command-not-found, 128+N =
 * terminated by signal N (the common timeout/OOM/segv range). These are
 * unambiguous "did not execute", so they map to `execution_failed`, not
 * `candidate_red`. An ordinary nonzero (e.g. 1 = assertion failed) stays
 * `candidate_red`.
 */
const isInfraExitCode = (exitCode: number): boolean =>
  exitCode === 126 || exitCode === 127 || (exitCode >= 128 && exitCode <= 165) || exitCode < 0

const proofStateOf = (
  source: RepairValidationSource | undefined,
  exitCode: number | undefined,
  outcome: RepairReproOutcome | undefined,
): ProofReceiptState => {
  if (source === undefined || source === "none") return "not_run"
  // A3: the validator's OWN pre-classified exec failure is authoritative — the
  // command crashed / could not produce a verdict ⇒ infra, not candidate_red.
  if (outcome === "exec_failed") return "execution_failed"
  if (exitCode === undefined) return "not_run"
  if (exitCode === 0) return "candidate_green"
  return isInfraExitCode(exitCode) ? "execution_failed" : "candidate_red"
}

const proofSourceOf = (source: RepairValidationSource | undefined): string =>
  source === "primary_rail"
    ? "primary_rail"
    : source === "verify_cmd"
      ? "verify_cmd"
      : source === "repro"
        ? "public_repro"
        : "validation_gate"

const ownerRailResultOf = (
  source: RepairValidationSource | undefined,
  exitCode: number | undefined,
  outcome: RepairReproOutcome | undefined,
): "green" | "red" | "infra_failed" | "not_run" => {
  const state = proofStateOf(source, exitCode, outcome)
  return state === "candidate_green"
    ? "green"
    : state === "candidate_red"
      ? "red"
      : state === "execution_failed" || state === "env_prep_failed"
        ? "infra_failed"
        : "not_run"
}

/**
 * B1: owner evidence for the classic-repair packet. REUSES the slice-capable
 * `assembleOwnerEvidence` factory so a readable owner file + issue symbols yields
 * the EXACT symbol slice (not a path-only `symbols:[]` stub). No reader / no
 * resolvable symbol ⇒ path-only, and B2 surfaces the gap via `owner_slice`
 * missingEvidence. The provenance stays `repair-sibling-owner` (these owners come
 * from blind co-change resolution, never hidden test fields).
 */
const ownerEvidenceOf = (args: BuildRepairContextArgs): readonly OwnerEvidenceFact[] =>
  assembleOwnerEvidence({
    ownerFiles: [...new Set(args.siblingOwners ?? [])],
    provenance: "repair-sibling-owner",
    ...(args.issueSymbols !== undefined ? { issueSymbols: args.issueSymbols } : {}),
    ...(args.readSource !== undefined ? { readSource: args.readSource } : {}),
  })

/**
 * B7: the candidate's SOURCE-ONLY edit surface, derived from its OWN cumulative
 * diff (touched files + touched symbols). Never a hidden-test path / command.
 * Returns undefined when the patch is empty (nothing edited yet).
 */
const candidateEditSurfaceOf = (cumulativeDiff: string): CandidateEditSurfaceFact | undefined => {
  if (cumulativeDiff.trim() === "") return undefined
  const touchedFiles = filesFromUnifiedDiff(cumulativeDiff)
  const touchedSymbols = diffTouchedSymbols(cumulativeDiff)
  if (touchedFiles.length === 0 && touchedSymbols.length === 0) return undefined
  return { touchedFiles, touchedSymbols }
}

const proofReceiptsOf = (args: BuildRepairContextArgs): readonly ProofReceiptFact[] => {
  if (args.validationSource === undefined || args.validationSource === "none") return []
  if (
    args.validationSource === "primary_rail" &&
    (args.validationStepKind === "owner-test" || args.validationStepKind === "module-smoke")
  ) {
    return [
      ownerTestResultReceipt({
        kind: args.validationStepKind === "owner-test" ? "owner_test" : "module_smoke",
        result: ownerRailResultOf(
          args.validationSource,
          args.validationExitCode,
          args.validationOutcome,
        ),
      }),
    ]
  }
  const receipt: ProofReceiptFact = {
    source: proofSourceOf(args.validationSource),
    state: proofStateOf(args.validationSource, args.validationExitCode, args.validationOutcome),
    ...(args.validationCmd !== undefined && args.validationCmd !== ""
      ? { command: args.validationCmd }
      : {}),
    ...(args.failureEvidence?.stdoutTail !== undefined &&
    args.failureEvidence.stdoutTail.trim() !== ""
      ? { stdoutTail: boundTailMarker(args.failureEvidence.stdoutTail, 600) }
      : {}),
    ...(args.failureEvidence?.stderrTail !== undefined &&
    args.failureEvidence.stderrTail.trim() !== ""
      ? { stderrTail: boundTailMarker(args.failureEvidence.stderrTail, 600) }
      : {}),
  }
  return [receipt]
}

const staticFactsOf = (args: BuildRepairContextArgs): readonly StaticFact[] => {
  const touchedFiles = filesFromUnifiedDiff(args.cumulativeDiff)
  const validationFailTail = combinedFailureTailOf(args)
  return [
    { kind: "repair_round", value: String(args.round) },
    {
      kind: "cumulative_patch_files",
      value: touchedFiles.length > 0 ? touchedFiles.join(", ") : "<none>",
    },
    ...(args.cumulativeDiff.trim() !== ""
      ? [{ kind: "cumulative_patch_excerpt", value: boundHeadMarker(args.cumulativeDiff, 1600) }]
      : []),
    ...(validationFailTail.trim() !== ""
      ? [{ kind: "validation_fail_tail", value: boundTailMarker(validationFailTail, 1000) }]
      : []),
    ...(args.validationSource !== undefined
      ? [{ kind: "validation_source", value: args.validationSource }]
      : []),
    ...(args.predicateSummary !== undefined && args.predicateSummary.trim() !== ""
      ? [{ kind: "typed_predicate_summary", value: boundHeadMarker(args.predicateSummary, 600) }]
      : []),
  ]
}

const missingEvidenceOf = (
  args: BuildRepairContextArgs,
  ownerEvidence: readonly OwnerEvidenceFact[],
): readonly MissingEvidenceFact[] => [
  ...(args.validationSource === undefined || args.validationSource === "none"
    ? [{ kind: "verification_command", reason: "no_runnable_validation_gate_captured" }]
    : []),
  ...(args.validationSource !== undefined &&
  args.validationSource !== "none" &&
  args.validationCmdWithheld !== true &&
  (args.validationCmd === undefined || args.validationCmd.trim() === "")
    ? [{ kind: "verification_command", reason: "validation_gate_missing_command_text" }]
    : []),
  // B2: a missing owner slice is VISIBLE here, mirroring candidate_generation.
  ...ownerSliceMissingEvidence(ownerEvidence),
]

export const buildRepairRoundLlmEvidencePacket = (
  args: BuildRepairContextArgs,
): LlmEvidencePacket => {
  const ownerEvidence = ownerEvidenceOf(args)
  const editSurface = candidateEditSurfaceOf(args.cumulativeDiff)
  return cleanPacket({
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
      `issue summary: ${boundHeadMarker(args.problem, 500)}`,
      ...(args.siblingOwners !== undefined && args.siblingOwners.length > 0
        ? [`co_change_sites: ${[...new Set(args.siblingOwners)].join(", ")}`]
        : []),
    ],
    ownerEvidence,
    proofReceipts: proofReceiptsOf(args),
    contractFacts: [],
    staticFacts: staticFactsOf(args),
    // B3: forward the active proof target (selector-repair sibling already does).
    ...(args.verificationTarget !== undefined
      ? { verificationTarget: args.verificationTarget }
      : {}),
    // B7: candidate's own touched files/symbols (source-only).
    ...(editSurface !== undefined ? { candidateEditSurface: editSurface } : {}),
    missingEvidence: missingEvidenceOf(args, ownerEvidence),
  })
}

export const buildRepairRoundSeedMessage = (
  args: BuildRepairContextArgs,
  seedText: string = buildRepairContext(args),
): { readonly packet: LlmEvidencePacket; readonly seedMsg: string } => {
  const packet = buildRepairRoundLlmEvidencePacket(args)
  return {
    packet,
    seedMsg: `${renderLlmEvidencePacket(packet)}\n\n${seedText}`,
  }
}
