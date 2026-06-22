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

export const buildSelectionRiskGate = (
  args: BuildSelectionRiskGateArgs,
): ((candidate: Candidate) => Promise<SelectionRiskGateDecision>) | undefined => {
  if (!args.structural && args.llmMode === undefined) return undefined
  return async (candidate: Candidate): Promise<SelectionRiskGateDecision> => {
    const structural = structuralDecisionOf(args, candidate)
    if (args.llmMode === undefined) return structural
    if (args.llmMode === "on" && structural.expand) return structural
    const llm = await llmDecisionOf(args, candidate)
    return args.llmMode === "shadow"
      ? {
          expand: structural.expand,
          reasons: structural.reasons,
          ...(structural.patchBudget !== undefined ? { patchBudget: structural.patchBudget } : {}),
          ...(llm.llmEvidencePacket !== undefined ? { llmEvidencePacket: llm.llmEvidencePacket } : {}),
          shadow: {
            expand: llm.expand,
            reasons: llm.reasons,
          },
        }
      : {
          expand: structural.expand || llm.expand,
          reasons: [...structural.reasons, ...llm.reasons],
          ...(structural.patchBudget !== undefined ? { patchBudget: structural.patchBudget } : {}),
          ...(llm.llmEvidencePacket !== undefined ? { llmEvidencePacket: llm.llmEvidencePacket } : {}),
        }
  }
}
