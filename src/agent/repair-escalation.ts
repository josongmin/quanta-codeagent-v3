/**
 * T-601 — RepairEscalationDecision. Widen (branch-search / subagent) ONLY on
 * explicit multi-owner evidence, never as a default preset. PURE + deterministic:
 * escalate iff ≥2 CORROBORATED strong owners exist AND the single-owner primary
 * rail stayed red after repair. Otherwise do not widen on a hunch.
 */

export interface EscalationCandidate {
  file: string
  score: number
  /** Provenance from FaultEvidencePacket (stage1 / issue-file / owner-resolve). */
  sources: readonly string[]
}

export interface EscalationInput {
  candidates: readonly EscalationCandidate[]
  /** Did the single-owner attempt's primary rail stay red after repair? */
  primaryRailRedAfterRepair: boolean
  /** Minimum score for a "strong" owner. */
  minOwnerScore?: number
  /** WS2: owner-admission flagged an owner-family / cross-owner — a co-change
   *  site (e.g. a parent/child override sibling resolved via LSP `ownerResolved`)
   *  exists in the evidence. A single-site edit that left the rail red is then
   *  INCOMPLETE, so widen with reason `sibling_coverage_missing` instead of
   *  declaring the single owner done. Absent/false ⇒ legacy strong-owner gate. */
  siblingCoverageExpected?: boolean
}

export interface EscalationDecision {
  escalate: boolean
  owners: string[]
  reason: string
}

const DEFAULT_MIN_SCORE = 3

/** A strong owner is high-scoring AND corroborated (resolved by LSP, or pointed
 *  at by ≥2 evidence streams) — a bare single stage-1 hit is not enough. */
const isStrong = (c: EscalationCandidate, minScore: number): boolean =>
  c.score >= minScore && (c.sources.includes("owner-resolve") || c.sources.length >= 2)

export const decideEscalation = (input: EscalationInput): EscalationDecision => {
  const minScore = input.minOwnerScore ?? DEFAULT_MIN_SCORE
  const strong = input.candidates.filter((c) => isStrong(c, minScore))

  if (!input.primaryRailRedAfterRepair) {
    return { escalate: false, owners: [], reason: "primary rail not red after repair — no widening" }
  }
  // WS2 sibling-coverage gate (the #14315 multi-site lever). owner-admission saw
  // an owner-family / cross-owner — a co-change site (an LSP-resolved parent/child
  // override sibling) sits in the evidence. The single-site attempt left the rail
  // red, so it is INCOMPLETE: block continue-single-owner and emit a multi-owner
  // plan over the owner-resolve (sibling) candidates + any strong owners. Fires
  // BEFORE the strong≥2 gate because one corroborated owner + a known sibling is
  // exactly the case the legacy gate misses (it needs two strong owners).
  if (input.siblingCoverageExpected === true) {
    const siblings = input.candidates.filter((c) => c.sources.includes("owner-resolve"))
    const owners = [...new Set([...strong, ...siblings].map((c) => c.file))]
    if (owners.length > 0) {
      return {
        escalate: true,
        owners,
        reason:
          siblings.length > 0
            ? `sibling_coverage_missing — owner-family co-change site(s) ${siblings
                .map((c) => c.file)
                .join(", ")} present; single-site edit insufficient`
            : "sibling_coverage_missing — owner-family expected; single-site edit insufficient",
      }
    }
  }
  if (strong.length < 2) {
    return {
      escalate: false,
      owners: strong.map((c) => c.file),
      reason: `only ${strong.length} corroborated owner(s) — insufficient multi-owner evidence to widen`,
    }
  }
  return {
    escalate: true,
    owners: strong.map((c) => c.file),
    reason: `${strong.length} corroborated owners + primary rail still red — explicit multi-owner case`,
  }
}
