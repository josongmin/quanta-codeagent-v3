/**
 * OPC-07 — packet normalization + render. `cleanPacket` dedupes every field,
 * normalizes proof-receipt source policies, and runs the HARD blindness check;
 * `renderLlmEvidencePacket` serializes the cleaned packet for prompt injection.
 */

import { assertPacketBlind } from "./guards"
import { normalizeProofReceipt } from "./policy"
import { uniqueLines, uniqueObjects } from "./text-utils"
import type { LlmEvidencePacket } from "./types"

/** Normalize + dedupe + HARD blindness check. Idempotent. */
export const cleanPacket = (packet: LlmEvidencePacket): LlmEvidencePacket =>
  assertPacketBlind({
    ...packet,
    allowedActions: uniqueLines(packet.allowedActions),
    forbiddenSources: uniqueLines(packet.forbiddenSources),
    publicIssueFacts: uniqueLines(packet.publicIssueFacts),
    ownerEvidence: uniqueObjects(packet.ownerEvidence),
    proofReceipts: uniqueObjects(packet.proofReceipts).map(normalizeProofReceipt),
    contractFacts: uniqueObjects(packet.contractFacts),
    staticFacts: uniqueObjects(packet.staticFacts),
    missingEvidence: uniqueObjects(packet.missingEvidence),
  })

/** Render the typed packet for prompt injection. */
export const renderLlmEvidencePacket = (packet: LlmEvidencePacket): string =>
  [
    "## LLM Evidence Packet",
    "Use only the bounded packet below. Do not assume hidden tests, gold patches, benchmark labels, or undocumented authority.",
    "```json",
    JSON.stringify(cleanPacket(packet), null, 2),
    "```",
  ].join("\n")
