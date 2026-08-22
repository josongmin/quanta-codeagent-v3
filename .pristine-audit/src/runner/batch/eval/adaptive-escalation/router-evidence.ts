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
import { type EvidenceFacts, renderAdvisoryRouterFacts } from "./evidence-facts"

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
  const editSurface = packet.candidateEditSurface
  const thisHash = packet.candidatePatchHash
  // B9: a receipt is THIS candidate's proof when it carries no hash (unattributed
  // generation-path receipt) OR its hash matches the packet's candidate. A green
  // tagged to a DIFFERENT candidate must NOT count as this candidate's proof.
  const isThisCandidatesReceipt = (r: (typeof receipts)[number]): boolean =>
    r.candidatePatchHash === undefined ||
    thisHash === undefined ||
    r.candidatePatchHash === thisHash
  return {
    issueId: ISSUE_ID,
    candidateId: CANDIDATE_ID,
    ownersId: OWNERS_ID,
    proofId: PROOF_ID,
    // B9: a confident fix site is a resolved owner source-slice for a file the
    // CURRENT candidate actually TOUCHED (aligned via its edit surface). With no
    // edit surface (e.g. generation packets) this stays the coarse "any owner
    // sourceSlice" — backward-compatible. A slice for an UNTOUCHED owner no
    // longer fakes localization certainty for this candidate.
    localizationCertain: packet.ownerEvidence.some(
      (o) =>
        o.sourceSlice !== undefined &&
        (editSurface === undefined || editSurface.touchedFiles.includes(o.file)),
    ),
    // primary rail present ⇒ the declared condition has an executable check;
    // a target with no rail ⇒ declared-but-not-evidenced; no target ⇒ none.
    declaredConditionEvidenced: target === undefined ? null : target.primaryRail !== null,
    // B9: only THIS candidate's executed green counts as its positive proof.
    positiveProof: receipts.some(
      (r) => r.state === "candidate_green" && isThisCandidatesReceipt(r),
    ),
    multiOwnerLikely: packet.ownerEvidence.length > 1,
    baseReproEstablished:
      receipts.some((r) => r.baseValidatedRed === true) || target?.baseValidatedRed === true,
    regressionSignal: receipts.some((r) => r.source === "discovered_regression"),
    // jun-25: HARD infra veto must be backed by a REAL execution-failure receipt
    // only. The prior second disjunct also matched a `missingEvidence public_proof`
    // entry — but that entry is itself a DERIVED interpretive proxy
    // (selection's `proofState === "infra_blocked"` summary label,
    // llm-evidence-packet.ts:1841), not a receipt that the sandbox actually
    // failed to execute. Letting a proxy force-abort the model's chosen expensive
    // phase is exactly the bug this fix removes, so `infraBlocked` is now true
    // ONLY for a genuine `execution_failed` / `env_prep_failed` receipt. The
    // proxy still reaches the router as an ADVISORY evidence line via the rendered
    // packet (renderLlmEvidencePacket includes missingEvidence), so no signal is
    // lost — the model weighs it instead of being overridden by it.
    infraBlocked: receipts.some(
      (r) => r.state === "execution_failed" || r.state === "env_prep_failed",
    ),
  }
}

/**
 * Project the single-origin packet into the router read-model. `rendered` goes
 * through `renderLlmEvidencePacket` (blindness-audited) — projecting a poisoned
 * packet throws there, so blindness is enforced on the exact router-visible bytes.
 */
export const projectRouterEvidence = (packet: LlmEvidencePacket): RouterEvidence => {
  const facts = deriveEvidenceFactsFromPacket(packet)
  return {
    facts,
    // jun-25: append the advisory derived-facts block AFTER the blindness-audited
    // packet body. These are the signals the legality guard used to HARD-veto on
    // (proof-context / ordering); surfacing them lets the model weigh them itself
    // instead of having its chosen expensive phase silently force-aborted. The
    // advisory is derived from the SAME packet, so it adds no out-of-band info and
    // cannot leak an answer key (the packet bytes are already blindness-audited).
    rendered: `${renderLlmEvidencePacket(packet)}\n\n${renderAdvisoryRouterFacts(facts)}`,
    origin: { evidenceRevision: packet.evidenceRevision, instanceIdHash: packet.instanceIdHash },
  }
}
