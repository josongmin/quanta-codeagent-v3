/**
 * OPC-07 — typed, stage-scoped LLM evidence packet (BARREL).
 *
 * The implementation was split by concern into `./llm-evidence-packet/*` for
 * cohesion and to retire the god-module. This barrel re-exports the ENTIRE
 * original public surface (61 symbols) so external importers are unaffected —
 * every symbol resolves to a byte-identical body in its concern module:
 *
 *   - types.ts      — packet/evidence/artifact TYPES + error classes
 *   - policy.ts     — proof-receipt source-policy classification + receipt ctor
 *   - guards.ts     — HARD benchmark-blindness guard (forbidden markers)
 *   - hash.ts       — stable opaque identity hashes
 *   - clean.ts      — packet normalize/dedupe/render
 *   - summarize.ts  — LlmEvidenceArtifacts read/write (counts/summary/record)
 *   - assembly.ts   — symbol slices + owner evidence + verification target
 *   - builders.ts   — per-stage packet builders + phase-routing re-contract
 */

export {
  assembleOwnerEvidence,
  assembleStaticWitnessOwnerEvidence,
  buildSelectionOwnerEvidence,
  describeIssueFacts,
  extractSymbolSlice,
  extractSymbolSliceResult,
  ownerSliceMissingEvidence,
  staticWitnessDiagnosticsFacts,
  verificationTargetFromPlan,
} from "./llm-evidence-packet/assembly"
export type {
  CandidatePostReviewPacketInput,
  CandidateReviewPacketInput,
  IntakeLlmEvidenceInput,
  RepairSeedPacketInput,
  SelectionExplanationCandidateInput,
  SelectionExplanationLlmEvidenceInput,
  SelectionExplanationProofSummaryInput,
  SelectionGenerationPacketInput,
  SelectionGenerationPromptInput,
} from "./llm-evidence-packet/builders"
export {
  buildCandidatePostReviewLlmEvidencePacket,
  buildCandidateReviewLlmEvidencePacket,
  buildIntakeLlmEvidencePacket,
  buildRepairSeedLlmEvidencePacket,
  buildSelectionExplanationPacket,
  buildSelectionGenerationLlmEvidencePacket,
  buildSelectionGenerationPrompt,
  PHASE_ROUTING_QUESTION,
  toPhaseRoutingContract,
} from "./llm-evidence-packet/builders"
export { cleanPacket, renderLlmEvidencePacket } from "./llm-evidence-packet/clean"
export {
  assertEvidenceTextBlind,
  assertPacketBlind,
  FORBIDDEN_PACKET_MARKERS,
  PacketBlindnessViolation,
} from "./llm-evidence-packet/guards"
export {
  candidatePatchHash,
  opaqueInstanceIdHash,
  stableHash,
} from "./llm-evidence-packet/hash"
export { ownerTestResultReceipt, sourcePolicyOf } from "./llm-evidence-packet/policy"
export {
  llmEvidencePacketCounts,
  recordLlmEvidencePacket,
  summarizeLlmEvidenceArtifacts,
} from "./llm-evidence-packet/summarize"
export type {
  CandidateEditSurfaceFact,
  ContractFact,
  LlmEvidenceArtifacts,
  LlmEvidencePacket,
  LlmEvidencePacketCounts,
  LlmEvidencePacketStage,
  LlmEvidenceRevisionByStage,
  LlmEvidenceSummary,
  MissingEvidenceFact,
  OwnerEvidenceFact,
  OwnerSourceSlice,
  ProofReceiptFact,
  ProofReceiptSourcePolicy,
  ProofReceiptState,
  StaticFact,
  SymbolSliceMiss,
  SymbolSliceResult,
  VerificationStepFact,
  VerificationTargetFact,
} from "./llm-evidence-packet/types"
export { ProofReceiptSourcePolicyError } from "./llm-evidence-packet/types"
