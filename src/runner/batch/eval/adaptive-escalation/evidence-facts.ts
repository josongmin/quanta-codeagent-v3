/**
 * Router evidence facts — the typed INPUT the adaptive router reasons over
 * (jun-22 v5 Wave-1 skeleton, group B router-facing core).
 *
 * This is the router's VIEW of the evidence, not a competing packet builder: it
 * is a minimal typed-facts contract + the deterministic gap classifier + a
 * renderer for the prompt. Wave 3 POPULATES `EvidenceFacts` from the existing
 * evidence SSOT (`llm-evidence-packet.ts` — currently in-flight, not touched
 * here), so there is exactly one place facts originate; this module only
 * CONSUMES facts. It is `P` for the generic `runAdaptiveEscalation` controller
 * (with {@link evidenceIdsOf} as the `citableIds` extractor).
 *
 * `deriveEvidenceGaps` is the deterministic "what is missing" rule the v5 readme
 * asks for (localization / proof / synthesis / infra). It is a reference signal:
 * the model still emits its own cited gaps, but the controller can record /
 * cross-check against this deterministic baseline.
 */

import type { EvidenceGap } from "./decision-schema"

/**
 * Minimal evidence the router needs. Each section carries a stable id so the
 * model may CITE it (and the parser can scope-check citations). The booleans are
 * the discriminating signals the gap classifier reads — kept flat and explicit
 * so the derivation is a pure, total function with no hidden inputs.
 */
export interface EvidenceFacts {
  readonly issueId: string
  readonly candidateId: string
  readonly ownersId: string
  readonly proofId: string
  /** Candidate is confidently on the right owner/site. */
  readonly localizationCertain: boolean
  /** The issue's declared condition is evidenced. `null` ⇒ issue declares none. */
  readonly declaredConditionEvidenced: boolean | null
  /** Candidate has an executed positive proof. */
  readonly positiveProof: boolean
  /** The fix likely spans multiple owners/sites. */
  readonly multiOwnerLikely: boolean
  /** A base reproduction has been established. */
  readonly baseReproEstablished: boolean
  /** A regression keep-green signal is available. */
  readonly regressionSignal: boolean
  /** Environment / build / tooling blocks progress. */
  readonly infraBlocked: boolean
}

/** The evidence ids the router may cite for these facts. */
export const evidenceIdsOf = (f: EvidenceFacts): ReadonlySet<string> =>
  new Set([f.issueId, f.candidateId, f.ownersId, f.proofId])

/**
 * Deterministic gap classifier (total, pure, order-stable). Each gap fires from
 * exactly one fact, so flipping one fact toggles exactly one gap (paired-control).
 */
export const deriveEvidenceGaps = (f: EvidenceFacts): readonly EvidenceGap[] => {
  const gaps: EvidenceGap[] = []
  if (!f.localizationCertain) gaps.push("localization_uncertain")
  if (f.declaredConditionEvidenced === false) gaps.push("issue_condition_not_evidenced")
  if (!f.positiveProof) gaps.push("candidate_no_positive_proof")
  if (f.multiOwnerLikely) gaps.push("multi_owner_likely")
  if (!f.baseReproEstablished) gaps.push("base_repro_missing")
  if (!f.regressionSignal) gaps.push("regression_signal_missing")
  if (f.infraBlocked) gaps.push("infra_blocked")
  return gaps
}

/** A fully-evidenced facts object with NO gaps — the paired-control baseline and
 *  a convenient starting point for callers that toggle individual signals. */
export const fullyEvidencedFacts = (ids: {
  issueId: string
  candidateId: string
  ownersId: string
  proofId: string
}): EvidenceFacts => ({
  ...ids,
  localizationCertain: true,
  declaredConditionEvidenced: true,
  positiveProof: true,
  multiOwnerLikely: false,
  baseReproEstablished: true,
  regressionSignal: true,
  infraBlocked: false,
})

const yn = (b: boolean): string => (b ? "yes" : "no")

/** Render the facts into the prompt body consumed by `buildRouterPrompt`. Each
 *  line leads with the citable id so the model knows what it may reference. */
export const renderEvidenceFacts = (f: EvidenceFacts): string =>
  [
    `[${f.issueId}] issue declared-condition evidenced: ${
      f.declaredConditionEvidenced === null ? "n/a" : yn(f.declaredConditionEvidenced)
    }`,
    `[${f.candidateId}] localization certain: ${yn(f.localizationCertain)}; positive proof: ${yn(
      f.positiveProof,
    )}`,
    `[${f.ownersId}] multi-owner likely: ${yn(f.multiOwnerLikely)}`,
    `[${f.proofId}] base repro established: ${yn(f.baseReproEstablished)}; regression signal: ${yn(
      f.regressionSignal,
    )}; infra blocked: ${yn(f.infraBlocked)}`,
  ].join("\n")
