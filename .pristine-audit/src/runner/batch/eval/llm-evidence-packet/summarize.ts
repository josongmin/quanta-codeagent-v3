/**
 * OPC-07 — LlmEvidenceArtifacts read/write surface: per-stage packet readers,
 * counts, summary, and the append-only record sink. Storage-shaped concern —
 * no packet construction here, only reading/appending typed artifacts.
 */

import { uniqueLines } from "./text-utils"
import type {
  LlmEvidenceArtifacts,
  LlmEvidencePacket,
  LlmEvidencePacketCounts,
  LlmEvidencePacketStage,
  LlmEvidenceSummary,
} from "./types"

type MutableLlmEvidenceArtifacts = {
  intake?: LlmEvidencePacket
  candidateReview?: LlmEvidencePacket
  candidateReviewHistory?: LlmEvidencePacket[]
  candidatePostReview?: LlmEvidencePacket
  candidatePostReviewHistory?: LlmEvidencePacket[]
  candidateGeneration?: LlmEvidencePacket
  candidateGenerationHistory?: LlmEvidencePacket[]
  repairSeed?: LlmEvidencePacket
  repairSeedHistory?: LlmEvidencePacket[]
  selectionExplanation?: LlmEvidencePacket
  selectionExplanationHistory?: LlmEvidencePacket[]
}

const LLM_EVIDENCE_STAGE_ORDER: readonly LlmEvidencePacketStage[] = [
  "intake",
  "candidate_generation",
  "candidate_review",
  "candidate_post_review",
  "repair_seed",
  "selection_explanation",
]

const singletonPacket = (packet: LlmEvidencePacket | undefined): readonly LlmEvidencePacket[] =>
  packet === undefined ? [] : [packet]

const packetHistory = (
  current: LlmEvidencePacket | undefined,
  history: readonly LlmEvidencePacket[] | undefined,
): readonly LlmEvidencePacket[] =>
  history !== undefined && history.length > 0 ? history : singletonPacket(current)

const STAGE_PACKET_READERS: Readonly<
  Partial<
    Record<
      LlmEvidencePacketStage,
      (artifacts: LlmEvidenceArtifacts) => readonly LlmEvidencePacket[]
    >
  >
> = {
  intake: (artifacts) => singletonPacket(artifacts.intake),
  candidate_review: (artifacts) =>
    packetHistory(artifacts.candidateReview, artifacts.candidateReviewHistory),
  candidate_post_review: (artifacts) =>
    packetHistory(artifacts.candidatePostReview, artifacts.candidatePostReviewHistory),
  candidate_generation: (artifacts) =>
    packetHistory(artifacts.candidateGeneration, artifacts.candidateGenerationHistory),
  repair_seed: (artifacts) => packetHistory(artifacts.repairSeed, artifacts.repairSeedHistory),
  selection_explanation: (artifacts) =>
    packetHistory(artifacts.selectionExplanation, artifacts.selectionExplanationHistory),
}

const stagePackets = (
  artifacts: LlmEvidenceArtifacts,
  stage: LlmEvidencePacketStage,
): readonly LlmEvidencePacket[] => STAGE_PACKET_READERS[stage]?.(artifacts) ?? []

const packetsFromArtifacts = (artifacts: LlmEvidenceArtifacts): readonly LlmEvidencePacket[] =>
  LLM_EVIDENCE_STAGE_ORDER.flatMap((stage) => stagePackets(artifacts, stage))

export const llmEvidencePacketCounts = (
  artifacts: LlmEvidenceArtifacts | undefined,
): LlmEvidencePacketCounts | undefined => {
  if (artifacts === undefined) return undefined
  const candidateGeneration = stagePackets(artifacts, "candidate_generation").length
  const repairSeed = stagePackets(artifacts, "repair_seed").length
  const selectionExplanation = stagePackets(artifacts, "selection_explanation").length
  if (candidateGeneration === 0 && repairSeed === 0 && selectionExplanation === 0) return undefined
  return { candidateGeneration, repairSeed, selectionExplanation }
}

export const summarizeLlmEvidenceArtifacts = (
  artifacts: LlmEvidenceArtifacts | undefined,
): LlmEvidenceSummary | undefined => {
  if (artifacts === undefined) return undefined
  const packets = packetsFromArtifacts(artifacts)
  if (packets.length === 0) return undefined
  const revisionByStage: Partial<Record<LlmEvidencePacketStage, string>> = {}
  for (const packet of packets) revisionByStage[packet.stage] = packet.evidenceRevision
  return {
    stages: LLM_EVIDENCE_STAGE_ORDER.filter((stage) => stagePackets(artifacts, stage).length > 0),
    revisionByStage,
    missingKinds: uniqueLines(
      packets.flatMap((packet) => packet.missingEvidence.map((missing) => missing.kind)),
    ),
  }
}

type PacketSingletonKey =
  | "candidateReview"
  | "candidatePostReview"
  | "candidateGeneration"
  | "repairSeed"
  | "selectionExplanation"

type PacketHistoryKey =
  | "candidateReviewHistory"
  | "candidatePostReviewHistory"
  | "candidateGenerationHistory"
  | "repairSeedHistory"
  | "selectionExplanationHistory"

const recordHistoricalPacket = (
  sink: MutableLlmEvidenceArtifacts,
  packet: LlmEvidencePacket,
  singletonKey: PacketSingletonKey,
  historyKey: PacketHistoryKey,
): void => {
  const current = sink[singletonKey]
  if (current === undefined) {
    sink[singletonKey] = packet
    sink[historyKey] = [packet]
    return
  }
  sink[historyKey] = [...(sink[historyKey] ?? [current]), packet]
}

export const recordLlmEvidencePacket = (
  artifacts: Partial<LlmEvidenceArtifacts>,
  packet: LlmEvidencePacket,
): void => {
  const sink = artifacts as MutableLlmEvidenceArtifacts
  if (packet.stage === "intake" && sink.intake === undefined) sink.intake = packet
  if (packet.stage === "candidate_review") {
    recordHistoricalPacket(sink, packet, "candidateReview", "candidateReviewHistory")
  }
  if (packet.stage === "candidate_post_review") {
    recordHistoricalPacket(sink, packet, "candidatePostReview", "candidatePostReviewHistory")
  }
  if (packet.stage === "candidate_generation") {
    recordHistoricalPacket(sink, packet, "candidateGeneration", "candidateGenerationHistory")
  }
  if (packet.stage === "repair_seed") {
    recordHistoricalPacket(sink, packet, "repairSeed", "repairSeedHistory")
  }
  if (packet.stage === "selection_explanation") {
    recordHistoricalPacket(sink, packet, "selectionExplanation", "selectionExplanationHistory")
  }
}
