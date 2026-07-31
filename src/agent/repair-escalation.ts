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
  /** WS2: the feeder's resolved co-change sibling files — the SAME unsliced
   *  `ownerResolved` list the repair-seed widen uses. Keyed here (not off the
   *  post-`maxCandidates`-slice packet candidates) so the gate's telemetry can't
   *  disagree with the actual seed-widen behavior on a sibling ranked out of the
   *  top-K. Empty ⇒ legacy strong≥2 gate. */
  siblingFiles?: readonly string[]
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
    return {
      escalate: false,
      owners: [],
      reason: "primary rail not red after repair — no widening",
    }
  }
  // WS2 sibling-coverage gate (the #14315 multi-site lever). Keys off the FEEDER's
  // unsliced `siblingFiles` (the SAME list the repair-seed widen injects) — so the
  // gate's record can never disagree with the actual seed-widen behavior, and it's
  // not vulnerable to a real sibling being ranked out of the top-K packet
  // candidates. The single-site attempt left the rail red, so it is INCOMPLETE:
  // emit a multi-owner plan over those siblings + any strong owners. Fires BEFORE
  // the strong≥2 gate because one owner + a known sibling is exactly the case the
  // legacy gate misses (it needs two strong owners).
  const siblings = [...new Set(input.siblingFiles ?? [])]
  if (siblings.length > 0) {
    const owners = [...new Set([...strong.map((c) => c.file), ...siblings])]
    return {
      escalate: true,
      owners,
      reason: `sibling_coverage_missing — co-change site(s) ${siblings.join(", ")} present; single-site edit insufficient`,
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
