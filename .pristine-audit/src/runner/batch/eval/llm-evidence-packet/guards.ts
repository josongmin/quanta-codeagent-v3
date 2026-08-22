/**
 * OPC-07 — Benchmark-blindness guard (HARD).
 *
 * Structural SWE-bench dataset KEYS must never leak into an evidence field. This
 * module owns the forbidden-marker set, the violation error, the evidence-string
 * collectors, and the throwing assertions run by every packet.
 */

import type {
  CandidateEditSurfaceFact,
  LlmEvidencePacket,
  LlmEvidencePacketStage,
  OwnerEvidenceFact,
  ProofReceiptFact,
  VerificationStepFact,
  VerificationTargetFact,
} from "./types"

/**
 * Structural SWE-bench dataset KEYS. These uppercase identifiers are not
 * natural-language tokens — their presence inside an evidence field means a
 * hidden-oracle leak (a dataset record was stringified into the packet). They
 * have zero false-positive risk in legitimate public issue prose, so the guard
 * can THROW on them even on the live path. (Lowercase field names like
 * `test_patch` are intentionally NOT listed: they collide with ordinary issue
 * prose, and a throw on the live intake path would fail a real instance. The
 * structural defense against those is construction-time discipline — builders
 * only consume the allowed blind inputs — not a content scan.)
 *
 * Matched only against evidence content, never the meta menu (`forbiddenSources`
 * legitimately *names* `gold_patch` as a thing the LLM must not use).
 */
export const FORBIDDEN_PACKET_MARKERS: readonly string[] = ["FAIL_TO_PASS", "PASS_TO_PASS"]

export class PacketBlindnessViolation extends Error {
  constructor(
    readonly marker: string,
    readonly stage: LlmEvidencePacketStage,
  ) {
    super(`packet blindness violation: forbidden marker "${marker}" leaked into ${stage} evidence`)
    this.name = "PacketBlindnessViolation"
  }
}

export const assertEvidenceTextBlind = (
  stage: LlmEvidencePacketStage,
  values: readonly (string | undefined)[],
): void => {
  for (const marker of FORBIDDEN_PACKET_MARKERS) {
    if (values.some((value) => value?.includes(marker) === true)) {
      throw new PacketBlindnessViolation(marker, stage)
    }
  }
}

/** All strings drawn from EVIDENCE fields only (not the meta action menu). */
const ownerEvidenceStrings = (o: OwnerEvidenceFact): string[] => [
  o.file,
  o.provenance,
  ...o.symbols,
  ...(o.sourceSlice !== undefined ? [o.sourceSlice] : []),
  // Every multi-site slice (and its label) is rendered to the LLM, so it must
  // also pass the blindness scan — no candidate site escapes the gold guard.
  ...(o.sourceSlices ?? []).flatMap((s) => [s.label, s.slice]),
]

const proofReceiptStrings = (r: ProofReceiptFact): string[] => [
  r.source,
  r.state,
  ...(r.command !== undefined ? [r.command] : []),
  ...(r.stdoutTail !== undefined ? [r.stdoutTail] : []),
  ...(r.stderrTail !== undefined ? [r.stderrTail] : []),
]

const candidateEditSurfaceStrings = (surface: CandidateEditSurfaceFact | undefined): string[] =>
  surface === undefined
    ? []
    : [
        ...surface.touchedFiles,
        ...surface.touchedSymbols,
        ...(surface.patchSummary !== undefined ? [surface.patchSummary] : []),
      ]

const verificationStepStrings = (step: VerificationStepFact): string[] => [
  ...(step.cmd !== undefined ? [step.cmd] : []),
  ...(step.successPredicate !== undefined ? [step.successPredicate] : []),
]

const verificationTargetStrings = (target: VerificationTargetFact | undefined): string[] =>
  target === undefined
    ? []
    : [
        ...(target.primaryRail !== null ? [target.primaryRail] : []),
        ...target.required,
        ...target.optional,
      ].flatMap(verificationStepStrings)

const evidenceStrings = (packet: LlmEvidencePacket): string[] => [
  ...packet.publicIssueFacts,
  ...packet.ownerEvidence.flatMap(ownerEvidenceStrings),
  ...packet.proofReceipts.flatMap(proofReceiptStrings),
  ...packet.contractFacts.flatMap((c) => [c.contractId, c.authority]),
  ...packet.staticFacts.flatMap((s) => [s.kind, s.value]),
  ...packet.missingEvidence.flatMap((m) => [m.kind, m.reason]),
  ...candidateEditSurfaceStrings(packet.candidateEditSurface),
  ...verificationTargetStrings(packet.verificationTarget),
]

/**
 * Throw if any forbidden benchmark marker leaked into an evidence field. HARD
 * guard (the easiest place to reintroduce answer-key leakage). A leak is a
 * construction bug that would corrupt measurement, so it fails LOUD rather than
 * silently scrubbing. Scans evidence only; the action menu may still name
 * forbidden sources. Run by every packet through {@link cleanPacket}.
 */
export const assertPacketBlind = (packet: LlmEvidencePacket): LlmEvidencePacket => {
  assertEvidenceTextBlind(packet.stage, evidenceStrings(packet))
  return packet
}
