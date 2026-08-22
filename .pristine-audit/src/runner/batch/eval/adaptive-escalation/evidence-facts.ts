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

/**
 * The derived "lacks proof context" signal (jun-25). This is the SAME predicate
 * the legality guard used to HARD-veto run_proof_clean / repair_with_proof on
 * (`!baseReproEstablished && declaredConditionEvidenced !== true`). It is now
 * SURFACED to the router as advisory so the model — not a derived proxy — decides
 * whether to enter a phase that might ESTABLISH that very context.
 */
export const lacksProofContext = (f: EvidenceFacts): boolean =>
  !f.baseReproEstablished && f.declaredConditionEvidenced !== true

/**
 * Advisory router facts block (jun-25). Surfaces the derived signals that the
 * legality guard previously force-aborted on — proof-context and the fact inputs
 * to the (now-removed) ordering vetoes — as EVIDENCE the model weighs itself. No
 * line here narrows the legal action set; it is purely informational. Worded so
 * the model understands an expensive phase MAY be the way to acquire missing
 * proof context, rather than being blocked from it.
 */
export const renderAdvisoryRouterFacts = (f: EvidenceFacts): string =>
  [
    "## Router Advisory Facts (derived; NOT restrictions — you decide)",
    `- base reproduction established: ${yn(f.baseReproEstablished)}`,
    `- issue declared-condition evidenced: ${
      f.declaredConditionEvidenced === null ? "n/a" : yn(f.declaredConditionEvidenced)
    }`,
    `- candidate has executed positive proof: ${yn(f.positiveProof)}`,
    `- lacks proof context (no base repro AND declared-condition not evidenced): ${yn(
      lacksProofContext(f),
    )}`,
    "  note: entering run_public_repro / run_proof_clean / repair_with_proof MAY be how you ESTABLISH missing proof context — this advisory does not forbid it.",
    `- infra blocked (real execution-failure receipt): ${yn(f.infraBlocked)}`,
  ].join("\n")
