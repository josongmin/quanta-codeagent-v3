/**
 * Adaptive (V5) phase EVIDENCE assembly + route telemetry (pure code motion
 * from `driver.ts`, byte-identical). Builds the per-phase {@link LlmEvidencePacket}
 * fed to the adaptive escalation router (`buildAdaptivePhasePacket`) from the
 * agent phase result, selection telemetry, static witnesses, and repro/proof
 * receipts, and projects the router outcome into result telemetry
 * (`adaptiveRouteTelemetryOf`). A leaf over `./context-types` + evidence-packet
 * siblings — no driver orchestration dependency.
 */

import { extractIssueHint } from "@/agent"
import type { OwnerSibling } from "@/agent/closure"
import { filesFromUnifiedDiff } from "@/shared"
import type { BenchReproTestTelemetry, Instance, InstanceResult } from "../../types"
import { ADAPTIVE_ACTIONS, type runAdaptiveBenchAttempt } from "../adaptive-escalation"
import { diffTouchedSymbols } from "../diff-touched-symbols"
import {
  buildCandidatePostReviewLlmEvidencePacket,
  buildSelectionExplanationPacket,
  buildSelectionOwnerEvidence,
  type CandidateEditSurfaceFact,
  candidatePatchHash,
  type LlmEvidencePacket,
  type MissingEvidenceFact,
  ownerTestResultReceipt,
  type ProofReceiptFact,
  toPhaseRoutingContract,
  verificationTargetFromPlan,
} from "../llm-evidence-packet"
import type { SelectionTelemetry } from "../selection-executor"
import {
  buildAstStaticWitnesses,
  type StaticWitnessDiagnostic,
  staticWitnessLanguageDiagnostics,
} from "../static-witness-adapter"
import {
  cleanUniqueList,
  type Phase,
  type PreparedAttemptContext,
  readSandboxSource,
} from "./context-types"

const dedupeProofReceipts = (
  receipts: readonly ProofReceiptFact[],
): readonly ProofReceiptFact[] => [
  ...new Map(
    receipts.map((receipt) => [
      `${receipt.source}:${receipt.state}:${receipt.command ?? ""}`,
      receipt,
    ]),
  ).values(),
]

const candidateEditSurfaceFromPatch = (patch: string): CandidateEditSurfaceFact | undefined => {
  if (patch.trim() === "") return undefined
  const touchedFiles = filesFromUnifiedDiff(patch)
  const touchedSymbols = diffTouchedSymbols(patch)
  if (touchedFiles.length === 0 && touchedSymbols.length === 0) return undefined
  return { touchedFiles, touchedSymbols }
}

const adaptiveStaticWitnessEvidence = (args: {
  readonly problemStatement: string
  readonly ownerFiles: readonly string[]
  readonly ownerResolved: readonly OwnerSibling[] | undefined
  readonly sandbox: string
}) => {
  const input = {
    problemStatement: args.problemStatement,
    ownerCandidates: args.ownerFiles,
    ...(args.ownerResolved !== undefined ? { ownerResolved: args.ownerResolved } : {}),
    readSource: (rel: string) => readSandboxSource(args.sandbox, rel),
  }
  return {
    staticWitnesses: buildAstStaticWitnesses(input),
    staticWitnessDiagnostics: staticWitnessLanguageDiagnostics(input),
  }
}

const adaptiveBaseReproReceipts = (
  reproTest: BenchReproTestTelemetry | undefined,
): readonly ProofReceiptFact[] => {
  if (reproTest === undefined) return []
  if (reproTest.installed) {
    return [
      {
        source: "public_mwe",
        sourcePolicy: "public_repro",
        state: reproTest.reproducedCount > 0 ? "base_red" : "base_green",
        command: reproTest.path,
        baseValidatedRed: reproTest.reproducedCount > 0,
      },
    ]
  }
  const infraReason =
    reproTest.reason === "not_installed" ||
    reproTest.reason === "write_failed" ||
    reproTest.reason === "unsupported_language"
      ? "env_prep_failed"
      : "execution_failed"
  return [{ source: "public_mwe", sourcePolicy: "public_repro", state: infraReason }]
}

const adaptiveSelectionProofReceipts = (
  proofSummary: Phase["selectionTelemetry"] extends infer T
    ? T extends { proofSummary?: infer S }
      ? S | undefined
      : never
    : never,
): readonly ProofReceiptFact[] => {
  if (proofSummary === undefined) return []
  const receipts: ProofReceiptFact[] = []
  switch (proofSummary.publicMweState) {
    case "base_red":
      receipts.push({
        source: "public_mwe",
        sourcePolicy: "public_repro",
        state: "base_red",
        baseValidatedRed: true,
      })
      break
    case "base_not_red":
      receipts.push({ source: "public_mwe", sourcePolicy: "public_repro", state: "base_green" })
      break
    case "patched_green":
      receipts.push({
        source: "public_mwe",
        sourcePolicy: "public_repro",
        state: "candidate_green",
        baseValidatedRed: true,
      })
      break
    case "candidate_red":
      receipts.push({
        source: "public_mwe",
        sourcePolicy: "public_repro",
        state: "candidate_red",
        baseValidatedRed: true,
      })
      break
    case "execution_failed":
      receipts.push({
        source: "public_mwe",
        sourcePolicy: "public_repro",
        state: "execution_failed",
      })
      break
  }
  switch (proofSummary.publicRegressionState) {
    case "safety_green":
      receipts.push({
        source: "discovered_regression",
        sourcePolicy: "public_discovered_test",
        state: "candidate_green",
      })
      break
    case "candidate_red":
      receipts.push({
        source: "discovered_regression",
        sourcePolicy: "public_discovered_test",
        state: "candidate_red",
      })
      break
    case "execution_failed":
      receipts.push({
        source: "discovered_regression",
        sourcePolicy: "public_discovered_test",
        state: "execution_failed",
      })
      break
    case "coverage_capped":
      receipts.push({
        source: "discovered_regression",
        sourcePolicy: "public_discovered_test",
        state: "static_only",
      })
      break
  }
  switch (proofSummary.reproConsensusState) {
    case "base_red_candidate_green":
      receipts.push({
        source: "repro_consensus",
        sourcePolicy: "public_repro",
        state: "candidate_green",
        baseValidatedRed: true,
      })
      break
    case "base_red_candidate_red":
      receipts.push({
        source: "repro_consensus",
        sourcePolicy: "public_repro",
        state: "candidate_red",
        baseValidatedRed: true,
      })
      break
    case "execution_failed":
      receipts.push({
        source: "repro_consensus",
        sourcePolicy: "public_repro",
        state: "execution_failed",
      })
      break
    case "false_negative_suspected":
      receipts.push({
        source: "repro_consensus",
        sourcePolicy: "public_repro",
        state: "static_only",
        baseValidatedRed: true,
      })
      break
  }
  // B5 — surface the executed module-smoke (public issue-smoke) HARD-gate RESULT
  // as a proof receipt the model/router sees. RESULT ONLY: `ownerTestResultReceipt`
  // builds it with `cmdWithheld:true` and never carries the command/selector
  // (C3 anti-gaming fence). Absent ⇒ the smoke gate did not run (FAIL-OPEN).
  if (proofSummary.moduleSmokeState !== undefined) {
    receipts.push(
      ownerTestResultReceipt({
        kind: "module_smoke",
        result: proofSummary.moduleSmokeState,
      }),
    )
  }
  return receipts
}

/**
 * A10 — the closed ROUTING action menu the router prompt enumerates. Passed into
 * {@link toPhaseRoutingContract} so the router-input packet's `allowedActions`
 * MATCH the router instruction's `ADAPTIVE_ACTIONS` (one coherent action menu),
 * instead of the source packet's stale "explain_*" / post-review actions.
 */
const ROUTING_ACTION_MENU: readonly string[] = [...ADAPTIVE_ACTIONS]

/**
 * Build the evidence packet the adaptive PHASE ROUTER sees for this phase. The
 * evidence BODY is the selection-explanation packet (when selection telemetry
 * exists) or a post-exec review packet (thin path); EITHER way the consumer is
 * the router asking "choose the next phase", so the packet is re-contracted via
 * {@link toPhaseRoutingContract} (A10): the model sees `stage:"phase_routing"`,
 * a phase-decision question, and the closed routing action menu — never the
 * stale "explain_*" / post-review contract. Only the stage/question/action menu
 * change; all evidence is preserved and re-blindness-checked. The report keeps
 * using the honest `selection_explanation`/`candidate_post_review` packet built
 * separately in `attachLlmEvidenceArtifacts`.
 */
export const buildAdaptivePhasePacket = (args: {
  readonly instance: Instance
  readonly phase: Phase
  readonly prepared: PreparedAttemptContext
  readonly sandbox: string
}): LlmEvidencePacket =>
  toPhaseRoutingContract(buildAdaptivePhaseEvidence(args), ROUTING_ACTION_MENU)

type AdaptivePhaseEvidenceArgs = {
  readonly instance: Instance
  readonly phase: Phase
  readonly prepared: PreparedAttemptContext
  readonly sandbox: string
}

const adaptiveOwnerFilesOf = (args: AdaptivePhaseEvidenceArgs): readonly string[] =>
  args.phase.selectionTelemetry?.ownerFiles ??
  cleanUniqueList([
    ...(args.prepared.closureSession?.bundle.evidence.candidates.map(
      (candidate) => candidate.file,
    ) ?? []),
    ...(args.prepared.ownerResolved?.map((owner) => owner.file) ?? []),
    ...args.prepared.localizeCandidates,
  ])

const buildAdaptiveSelectionEvidence = (args: {
  readonly problemStatement: string
  readonly telemetry: SelectionTelemetry
  readonly ownerFiles: readonly string[]
  readonly proofSummary: Parameters<typeof adaptiveSelectionProofReceipts>[0]
  readonly staticWitnessDiagnostics: readonly StaticWitnessDiagnostic[]
}): LlmEvidencePacket =>
  buildSelectionExplanationPacket({
    problemStatement: args.problemStatement,
    ownerFiles: args.ownerFiles,
    winnerId: args.telemetry.winnerId,
    ...(args.telemetry.noWinnerReason !== undefined
      ? { noWinnerReason: args.telemetry.noWinnerReason }
      : {}),
    ...(args.telemetry.proofRequired === true ? { proofRequired: true } : {}),
    ...(args.proofSummary !== undefined ? { proofSummary: args.proofSummary } : {}),
    candidates: args.telemetry.candidates,
    ...(args.staticWitnessDiagnostics.length > 0
      ? { staticWitnessDiagnostics: args.staticWitnessDiagnostics }
      : {}),
  })

const adaptiveMissingEvidenceOf = (args: {
  readonly phase: Phase
  readonly proofSummary: Parameters<typeof adaptiveSelectionProofReceipts>[0]
  readonly receipts: readonly ProofReceiptFact[]
}): readonly MissingEvidenceFact[] => {
  const missingEvidence: MissingEvidenceFact[] = []
  if (!args.receipts.some((receipt) => receipt.state === "candidate_green")) {
    missingEvidence.push({
      kind: "executed_public_proof",
      reason:
        args.proofSummary?.proofState === "infra_blocked"
          ? "public_proof_infra_blocked"
          : "no_positive_executed_public_proof",
    })
  }
  if (args.phase.stopReason === "error" && args.phase.agentError !== undefined) {
    missingEvidence.push({
      kind: "phase_error",
      reason: args.phase.agentError.slice(0, 240),
    })
  }
  return missingEvidence
}

const buildAdaptiveCandidatePostReviewEvidence = (args: {
  readonly phaseArgs: AdaptivePhaseEvidenceArgs
  readonly ownerFiles: readonly string[]
  readonly staticWitnesses: ReturnType<typeof adaptiveStaticWitnessEvidence>["staticWitnesses"]
  readonly staticWitnessDiagnostics: readonly StaticWitnessDiagnostic[]
  readonly proofSummary: Parameters<typeof adaptiveSelectionProofReceipts>[0]
}): LlmEvidencePacket => {
  const ownerEvidence = buildSelectionOwnerEvidence({
    ownerFiles: args.ownerFiles,
    issueSymbols: extractIssueHint(args.phaseArgs.instance.problemStatement).symbols,
    staticWitnesses: args.staticWitnesses,
    readSource: (rel) => readSandboxSource(args.phaseArgs.sandbox, rel),
  })
  const verificationTarget = verificationTargetFromPlan(args.phaseArgs.prepared.verificationPlan)
  const receipts = dedupeProofReceipts([
    ...adaptiveBaseReproReceipts(args.phaseArgs.prepared.reproTest),
    ...adaptiveSelectionProofReceipts(args.proofSummary),
  ])
  const missingEvidence = adaptiveMissingEvidenceOf({
    phase: args.phaseArgs.phase,
    proofSummary: args.proofSummary,
    receipts,
  })
  const candidateEditSurface = candidateEditSurfaceFromPatch(args.phaseArgs.phase.patch)
  return buildCandidatePostReviewLlmEvidencePacket({
    problemStatement: args.phaseArgs.instance.problemStatement,
    candidatePatchHash: candidatePatchHash(args.phaseArgs.phase.patch),
    ownerEvidence,
    proofReceipts: receipts,
    contracts: [],
    ...(verificationTarget !== undefined ? { verificationTarget } : {}),
    ...(candidateEditSurface !== undefined ? { candidateEditSurface } : {}),
    ...(args.staticWitnessDiagnostics.length > 0
      ? { staticWitnessDiagnostics: args.staticWitnessDiagnostics }
      : {}),
    ...(missingEvidence.length > 0 ? { missingEvidence } : {}),
  })
}

/** The evidence BODY for the router packet, before the A10 routing re-contract
 *  ({@link buildAdaptivePhasePacket} applies the contract). Kept separate so the
 *  evidence assembly is unit-testable independent of the stage rewrite. */
const buildAdaptivePhaseEvidence = (args: AdaptivePhaseEvidenceArgs): LlmEvidencePacket => {
  const proofSummary = args.phase.selectionTelemetry?.proofSummary
  const ownerFiles = adaptiveOwnerFilesOf(args)
  const { staticWitnesses, staticWitnessDiagnostics } = adaptiveStaticWitnessEvidence({
    problemStatement: args.instance.problemStatement,
    ownerFiles,
    ownerResolved: args.prepared.ownerResolved,
    sandbox: args.sandbox,
  })
  if (args.phase.selectionTelemetry !== undefined) {
    return buildAdaptiveSelectionEvidence({
      problemStatement: args.instance.problemStatement,
      telemetry: args.phase.selectionTelemetry,
      ownerFiles,
      proofSummary,
      staticWitnessDiagnostics,
    })
  }
  return buildAdaptiveCandidatePostReviewEvidence({
    phaseArgs: args,
    ownerFiles,
    staticWitnesses,
    staticWitnessDiagnostics,
    proofSummary,
  })
}

export const adaptiveRouteTelemetryOf = (
  run: Awaited<ReturnType<typeof runAdaptiveBenchAttempt>>,
  evidenceRevisions: readonly string[],
): NonNullable<InstanceResult["adaptiveRoute"]> => ({
  outcome: run.outcome,
  steps: run.steps,
  evidenceRevisions,
  ...(run.reason !== undefined ? { reason: String(run.reason) } : {}),
  ...(run.finalDecision !== undefined
    ? {
        finalAction: run.finalDecision.action,
        finalWhy: run.finalDecision.why,
        citedEvidenceIds: run.finalDecision.citedEvidenceIds,
      }
    : {}),
})
