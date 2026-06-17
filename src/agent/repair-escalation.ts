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
