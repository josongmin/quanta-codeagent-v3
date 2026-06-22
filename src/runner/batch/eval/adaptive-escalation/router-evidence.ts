/**
 * Router evidence read-model (jun-22 v5 / P5) — resolves the router-input SSOT.
 *
 * `LlmEvidencePacket` is the single ORIGIN of evidence (the blindness-audited
 * 6-section solver packet). `RouterEvidence` is a CQRS read-projection derived
 * from it, so the router never couples to the heavy packet shape and there is
 * exactly one place facts originate. This subsumes BOTH candidate router-input
 * approaches into one:
 *   - the lean `EvidenceFacts` view  → `RouterEvidence.facts` (packet-populated)
 *   - using the packet body directly → `RouterEvidence.rendered` (one render path)
 * so a separate `citableEvidenceIds(packet)` / `buildAdaptiveRouterPrompt(packet)`
 * is unnecessary: `evidenceIdsOf(re.facts)` is the citation scope and
 * `buildRouterPrompt(re.rendered)` is the prompt.
 *
 * Blindness is preserved by construction: `rendered` is `renderLlmEvidencePacket`
 * output, which runs `cleanPacket` + `assertPacketBlind` — so the exact bytes the
 * router sees are answer-key-blind (a poisoned packet THROWS here, at projection).
 */

import { type LlmEvidencePacket, renderLlmEvidencePacket } from "../llm-evidence-packet"
import type { EvidenceFacts } from "./evidence-facts"

/** The router's read-model: the lean discriminating facts + the blindness-audited
 *  packet body + an origin fingerprint for telemetry cross-checks. */
export interface RouterEvidence {
  readonly facts: EvidenceFacts
  readonly rendered: string
  readonly origin: { readonly evidenceRevision: string; readonly instanceIdHash: string }
}

// Stable citation ids (matching `evidence-facts.evidenceIdsOf`'s four sections),
// so the router's citable scope is independent of packet contents.
const ISSUE_ID = "issue"
const CANDIDATE_ID = "candidate"
const OWNERS_ID = "owners"
const PROOF_ID = "proof"

/**
 * Map the typed packet sections to the lean {@link EvidenceFacts} booleans
 * (pure, total, deterministic). The ONLY new fact-origin logic — every boolean
 * reads a specific packet condition so a single packet change flips a single
 * fact (paired-control).
 */
export const deriveEvidenceFactsFromPacket = (packet: LlmEvidencePacket): EvidenceFacts => {
  const receipts = packet.proofReceipts
  const target = packet.verificationTarget
  return {
    issueId: ISSUE_ID,
    candidateId: CANDIDATE_ID,
    ownersId: OWNERS_ID,
    proofId: PROOF_ID,
    // A resolved owner source-slice = a confident fix site.
    localizationCertain: packet.ownerEvidence.some((o) => o.sourceSlice !== undefined),
    // primary rail present ⇒ the declared condition has an executable check;
    // a target with no rail ⇒ declared-but-not-evidenced; no target ⇒ none.
    declaredConditionEvidenced:
      target === undefined ? null : target.primaryRail !== null ? true : false,
    positiveProof: receipts.some((r) => r.state === "candidate_green"),
    multiOwnerLikely: packet.ownerEvidence.length > 1,
    baseReproEstablished:
      receipts.some((r) => r.baseValidatedRed === true) || target?.baseValidatedRed === true,
    regressionSignal: receipts.some((r) => r.source === "discovered_regression"),
    infraBlocked:
      receipts.some((r) => r.state === "execution_failed" || r.state === "env_prep_failed") ||
      // The packet emits the infra-blocked signal as a `public_proof` missing
      // entry (reason `public_proof_infra_blocked`, llm-evidence-packet.ts:1185);
      // there is NO `*infra*` kind, so the prior `includes("infra")` was dead.
      // Match the real kind so a build/env block surfaces from missingEvidence too.
      packet.missingEvidence.some((m) => m.kind === "public_proof"),
  }
}

/**
 * Project the single-origin packet into the router read-model. `rendered` goes
 * through `renderLlmEvidencePacket` (blindness-audited) — projecting a poisoned
 * packet throws there, so blindness is enforced on the exact router-visible bytes.
 */
export const projectRouterEvidence = (packet: LlmEvidencePacket): RouterEvidence => ({
  facts: deriveEvidenceFactsFromPacket(packet),
  rendered: renderLlmEvidencePacket(packet),
  origin: { evidenceRevision: packet.evidenceRevision, instanceIdHash: packet.instanceIdHash },
})
