/**
 * Candidate family generation surface (T-GEN-09).
 *
 * Replaces the single ranked owner list with family-separated candidate
 * generation so that a small symptom patch cannot consume the whole search
 * space before the root / API / lifecycle owner is explored.
 *
 * AUTHORITY (per `docs/plans/jun-21-heuristic-authority-cleanup`):
 *   Candidate families shape EXPLORATION + final TIE-BREAK only. They hold the
 *   `familyOrdering` authority class in the lattice — they have NO veto, NO
 *   score, NO admissibility power, and perform NO instance-specific pattern
 *   matching. The planner here is a PURE deterministic ordering function over
 *   an already-built bundle; it never inspects issue text, file paths, or
 *   patch contents.
 */

/** Typed candidate-family identifiers. */
export type CandidateFamilyId =
  | "root-owner"
  | "symptom-owner"
  | "api-owner"
  | "lifecycle-owner"
  | "test-adjacent-owner"

/**
 * A single candidate family: a set of owner files reached via the same
 * static-engine evidence path, with provenance for telemetry.
 */
export interface CandidateFamily {
  readonly familyId: CandidateFamilyId
  readonly ownerFiles: readonly string[]
  readonly reason: string
  readonly seed: string | undefined
  readonly sourceEvidence: readonly string[]
}

/** Bundle of candidate families produced by the static engine. */
export interface CandidateFamilyBundle {
  readonly families: readonly CandidateFamily[]
}

/**
 * Fixed deterministic precedence for family round-robin.
 *
 * This is the STABLE ordering authority: root-owner is explored before a
 * symptom-owner family can be reused, so a symptom patch cannot monopolize the
 * search space. Ordering is fixed across runs; original bundle order is the
 * final tie-break (see `orderNonEmptyFamilies`).
 */
const FAMILY_PRECEDENCE: readonly CandidateFamilyId[] = [
  "root-owner",
  "api-owner",
  "lifecycle-owner",
  "symptom-owner",
  "test-adjacent-owner",
] as const

/** A family is non-empty iff it actually contributes at least one owner file. */
const isNonEmptyFamily = (family: CandidateFamily): boolean => family.ownerFiles.length > 0

/**
 * Deterministically order the non-empty families:
 *   1. fixed family precedence (FAMILY_PRECEDENCE),
 *   2. stable original bundle order as the final tie-break.
 *
 * Stable: families sharing a familyId keep their relative bundle order.
 */
const orderNonEmptyFamilies = (
  bundle: CandidateFamilyBundle,
): readonly CandidateFamily[] => {
  const withIndex = bundle.families
    .map((family, index) => ({ family, index }))
    .filter((entry) => isNonEmptyFamily(entry.family))

  const rankOf = (id: CandidateFamilyId): number => {
    const rank = FAMILY_PRECEDENCE.indexOf(id)
    // Unknown ids (should be unreachable given the typed union) sort last but
    // remain deterministic via the original-order tie-break.
    return rank === -1 ? FAMILY_PRECEDENCE.length : rank
  }

  return withIndex
    .slice()
    .sort((a, b) => {
      const byPrecedence = rankOf(a.family.familyId) - rankOf(b.family.familyId)
      if (byPrecedence !== 0) return byPrecedence
      return a.index - b.index
    })
    .map((entry) => entry.family)
}

/**
 * PURE family-separated ordering planner.
 *
 * Returns an array of up to `n` `CandidateFamily` references implementing the
 * COVERAGE GUARANTEE: emit at least one candidate from each non-empty family
 * before reusing any family — i.e. round-robin across the non-empty families in
 * the stable deterministic order above. A symptom-owner family therefore cannot
 * monopolize the plan before root-owner is explored.
 *
 * Degradation:
 *   - 0 non-empty families  -> empty plan.
 *   - 1 non-empty family    -> legacy single-family repetition (that family
 *     repeated up to `n` times).
 *
 * Determinism: identical input + `n` always yields a deep-equal plan.
 *
 * @param bundle  the candidate family bundle from the static engine.
 * @param n       maximum number of candidate slots to plan.
 */
export const planFamilyCoverage = (
  bundle: CandidateFamilyBundle,
  n: number,
): readonly CandidateFamily[] => {
  if (!Number.isFinite(n) || n <= 0) return []

  const ordered = orderNonEmptyFamilies(bundle)
  if (ordered.length === 0) return []

  const cap = Math.floor(n)
  const plan: CandidateFamily[] = []
  // Round-robin: pass `r` emits each family once, in stable order, before any
  // family is revisited in pass `r + 1`.
  while (plan.length < cap) {
    for (const family of ordered) {
      if (plan.length >= cap) break
      plan.push(family)
    }
  }
  return plan
}

/**
 * Convenience projection: the family-id plan, for telemetry / assertions where
 * only the family identity (not the full family object) is needed.
 */
export const planFamilyCoverageIds = (
  bundle: CandidateFamilyBundle,
  n: number,
): readonly CandidateFamilyId[] =>
  planFamilyCoverage(bundle, n).map((family) => family.familyId)
