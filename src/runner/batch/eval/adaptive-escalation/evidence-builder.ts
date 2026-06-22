/**
 * Evidence builder (jun-22 v5 Wave-3, group B — the missing populate step).
 *
 * SSOT collapse (D1/#3): `LlmEvidencePacket` (llm-evidence-packet.ts) is the ONE
 * evidence source. The router's minimal `EvidenceFacts` discriminant is a PURE,
 * DERIVED PROJECTION of that packet — never hand-authored. This module is the one
 * place the rich, open-vocab packet (proof receipts + owner evidence +
 * verification target + the open-string `missingEvidence.kind`) is projected onto
 * the closed 7-boolean discriminant the router reasons over.
 *
 * Two reconciliation rules keep it honest:
 *   - POSITIVE signals come from the packet's STRUCTURED fields (proof receipt
 *     states, owner files, verification target).
 *   - NEGATIVE signals come from `missingEvidence.kind` via ONE mapping table
 *     ({@link MISSING_KIND_SIGNAL}) — the single point where the open packet
 *     vocab reconciles with the closed `EvidenceGap` vocab (#3). A `missing`
 *     entry can only ever REMOVE confidence, never grant it.
 *
 * Conservative by construction: every boolean defaults to the "gap present" side
 * and is granted only on explicit positive evidence, so a thin/empty packet
 * routes toward escalation, never toward false confidence. Packet-blind by
 * inheritance (the packet already passed `assertPacketBlind`): no field read here
 * is a hidden oracle.
 */

import type {
  LlmEvidencePacket,
  MissingEvidenceFact,
  ProofReceiptFact,
} from "../llm-evidence-packet"
import type { EvidenceFacts } from "./evidence-facts"

/** Which discriminant a `missingEvidence.kind` negates (the #3 reconcile table).
 *  Open packet vocab → closed router signal, in exactly one place. A kind absent
 *  here carries no routing signal (it is packet-internal telemetry only). */
type NegatableSignal =
  | "localizationCertain"
  | "baseReproEstablished"
  | "positiveProof"
  | "declaredConditionEvidenced"

export const MISSING_KIND_SIGNAL: Readonly<Record<string, NegatableSignal | "infraBlocked">> = {
  owner_slice: "localizationCertain",
  fault_evidence: "localizationCertain",
  public_repro: "baseReproEstablished",
  public_mwe_seed: "baseReproEstablished",
  public_mwe_base: "baseReproEstablished",
  executed_public_proof: "positiveProof",
  verification_target: "declaredConditionEvidenced",
  verification_plan: "declaredConditionEvidenced",
  // `public_proof` is emitted with reason `public_proof_infra_blocked` — infra,
  // not a missing-evidence negation; handled as a positive infra signal below.
}

const hasState = (rs: readonly ProofReceiptFact[], states: readonly ProofReceiptFact["state"][]): boolean =>
  rs.some((r) => states.includes(r.state))

const missingKinds = (ms: readonly MissingEvidenceFact[]): ReadonlySet<string> =>
  new Set(ms.map((m) => m.kind))

const isNegated = (
  missing: ReadonlySet<string>,
  signal: NegatableSignal,
): boolean => {
  for (const [kind, sig] of Object.entries(MISSING_KIND_SIGNAL)) {
    if (sig === signal && missing.has(kind)) return true
  }
  return false
}

/**
 * Project the rich evidence packet onto the router's minimal `EvidenceFacts`.
 * Pure + total. Each boolean is granted ONLY on explicit positive evidence and
 * revoked by a matching `missingEvidence` entry — the conservative direction.
 */
export const buildEvidenceFactsFromPacket = (packet: LlmEvidencePacket): EvidenceFacts => {
  const owners = new Set(packet.ownerEvidence.map((o) => o.file))
  const missing = missingKinds(packet.missingEvidence)
  const receipts = packet.proofReceipts

  // POSITIVE signals from structured fields (revoked by `missing` below).
  const ownerSliceResolved =
    packet.ownerEvidence.length > 0 && packet.ownerEvidence.some((o) => o.sourceSlice !== undefined)
  const localizationCertain = ownerSliceResolved && !isNegated(missing, "localizationCertain")

  const positiveProof =
    hasState(receipts, ["candidate_green"]) && !isNegated(missing, "positiveProof")

  const baseReproEstablished =
    (packet.verificationTarget?.baseValidatedRed === true ||
      receipts.some(
        (r) => (r.source === "public_mwe" || r.source === "repro_consensus") && r.baseValidatedRed === true,
      )) && !isNegated(missing, "baseReproEstablished")

  const regressionSignal = receipts.some(
    (r) =>
      r.source === "discovered_regression" &&
      r.state !== "not_run" &&
      r.state !== "execution_failed" &&
      r.state !== "env_prep_failed",
  )

  const multiOwnerLikely = owners.size > 1

  // Infra: an execution/env-prep failure OR the explicit infra-blocked proof note.
  const infraBlocked =
    hasState(receipts, ["execution_failed", "env_prep_failed"]) || missing.has("public_proof")

  // Declared-condition: a primary verification rail means the issue declared an
  // expected condition. `null` ⇒ none declared. When declared, it is evidenced
  // only if the rail is not flagged missing/unsatisfied.
  const conditionDeclared = packet.verificationTarget?.primaryRail != null
  const declaredConditionEvidenced: boolean | null = !conditionDeclared
    ? null
    : !isNegated(missing, "declaredConditionEvidenced")

  return {
    issueId: `ev:issue:${packet.instanceIdHash}`,
    candidateId: `ev:cand:${packet.candidatePatchHash ?? "none"}`,
    ownersId: `ev:owners:${packet.instanceIdHash}`,
    proofId: `ev:proof:${packet.instanceIdHash}`,
    localizationCertain,
    declaredConditionEvidenced,
    positiveProof,
    multiOwnerLikely,
    baseReproEstablished,
    regressionSignal,
    infraBlocked,
  }
}
