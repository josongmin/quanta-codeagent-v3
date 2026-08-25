import type { LLMPort } from "@/llm"
import type { VerifySelectLlmRiskGateMode } from "@/runner/knobs/knobs/verify-select-llm-risk-gate"
import type { OwnerEvidenceFact } from "./llm-evidence-packet"
import { evaluateLlmPatchRisk } from "./llm-risk-gate"
import type { Candidate, SelectionRiskGateDecision } from "./selection-executor"
import { evaluateStrictPatchRisk } from "./strict-risk-gate"

export interface BuildSelectionRiskGateArgs {
  readonly structural: boolean
  readonly llmMode: VerifySelectLlmRiskGateMode | undefined
  readonly llm: LLMPort
  readonly problemStatement: string
  readonly ownerFiles?: readonly string[]
  readonly ownerEvidence?: readonly OwnerEvidenceFact[]
  readonly repo?: string
  readonly signal?: AbortSignal
}

const llmReasonPrefix = (reasons: readonly string[]): string[] => reasons.map((r) => `llm:${r}`)

const structuralDecisionOf = (
  args: BuildSelectionRiskGateArgs,
  candidate: Candidate,
): SelectionRiskGateDecision =>
  args.structural
    ? evaluateStrictPatchRisk({
        patch: candidate.patch,
        problemStatement: args.problemStatement,
        ...(args.ownerFiles !== undefined ? { ownerFiles: args.ownerFiles } : {}),
        ...(args.repo !== undefined ? { repo: args.repo } : {}),
      })
    : { expand: false, reasons: [] }

const llmDecisionOf = async (
  args: BuildSelectionRiskGateArgs,
  candidate: Candidate,
): Promise<SelectionRiskGateDecision> => {
  const llm = await evaluateLlmPatchRisk({
    llm: args.llm,
    problemStatement: args.problemStatement,
    patch: candidate.patch,
    candidateFiles: candidate.files,
    ...(args.ownerEvidence !== undefined ? { ownerEvidence: args.ownerEvidence } : {}),
    ...(args.ownerFiles !== undefined ? { ownerFiles: args.ownerFiles } : {}),
    ...(args.signal !== undefined ? { signal: args.signal } : {}),
  })
  return {
    expand: llm.expand,
    reasons: llmReasonPrefix(llm.reasons),
    llmEvidencePacket: llm.packet,
  }
}

/**
 * Fold the structural and LLM arms into one decision.
 *
 * `shadow` and the merging (`on`/`off`) modes previously spelled out two nearly
 * identical object literals that differed in exactly two fields — `expand` and
 * `reasons` — while repeating the same two optional-field spreads verbatim. One
 * builder, two ternaries: shadow REPORTS the structural verdict and files the
 * LLM's opinion under `shadow`; any other mode MERGES the two.
 */
const mergeRiskDecisions = (
  structural: SelectionRiskGateDecision,
  llm: SelectionRiskGateDecision,
  llmMode: VerifySelectLlmRiskGateMode,
): SelectionRiskGateDecision => {
  const isShadow = llmMode === "shadow"
  return {
    expand: isShadow ? structural.expand : structural.expand || llm.expand,
    reasons: isShadow ? structural.reasons : [...structural.reasons, ...llm.reasons],
    ...(structural.patchBudget !== undefined ? { patchBudget: structural.patchBudget } : {}),
    ...(llm.llmEvidencePacket !== undefined ? { llmEvidencePacket: llm.llmEvidencePacket } : {}),
    ...(isShadow ? { shadow: { expand: llm.expand, reasons: llm.reasons } } : {}),
  }
}

/**
 * Decide one candidate. Hoisted out of the factory's returned closure: as an
 * inner arrow every branch here paid a nesting surcharge, and none of it
 * actually depends on being inside the factory — only on `args`.
 */
const evaluateSelectionRisk = async (
  args: BuildSelectionRiskGateArgs,
  candidate: Candidate,
): Promise<SelectionRiskGateDecision> => {
  const structural = structuralDecisionOf(args, candidate)
  const llmMode = args.llmMode
  if (llmMode === undefined) return structural
  // `on` mode short-circuits: a structural expand is already decisive, so the
  // LLM call is skipped entirely.
  if (llmMode === "on" && structural.expand) return structural
  const llm = await llmDecisionOf(args, candidate)
  return mergeRiskDecisions(structural, llm, llmMode)
}

export const buildSelectionRiskGate = (
  args: BuildSelectionRiskGateArgs,
): ((candidate: Candidate) => Promise<SelectionRiskGateDecision>) | undefined => {
  if (!args.structural && args.llmMode === undefined) return undefined
  return (candidate: Candidate): Promise<SelectionRiskGateDecision> =>
    evaluateSelectionRisk(args, candidate)
}
