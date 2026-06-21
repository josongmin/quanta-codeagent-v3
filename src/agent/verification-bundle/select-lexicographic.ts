/**
 * Contract-first lexicographic candidate selection (T-SEL-06).
 *
 * Replaces weighted-sum ranking with STRICT authority tiers. A weighted sum lets
 * a small symptom patch buy its way past a stronger root-cause patch by being
 * cheaper on minimality; lexicographic comparison forbids that. The FIRST tier
 * where two candidates differ decides the winner, and no later tier can ever
 * overturn an earlier one.
 *
 * Authority order (highest authority first):
 *   0. mweProof                    (DESC) — executable PUBLIC-issue MWE verdict
 *        (+1 patched_green / 0 none|infra / -1 candidate_red). SCAFF-06: a
 *        candidate that provably passes a base-red public MWE outranks all
 *        non-proven ones; one that provably FAILS it is vetoed. Absent ⇒ 0, so
 *        selection is byte-identical until a real MWE execution feeds receipts.
 *   1. proofStrength               (DESC) — validated repro consensus votes/k
 *   2. executedKeepGreen           (DESC) — a clean EXECUTED keep-green suite passed
 *   3. requiredContractsSatisfied  (DESC) — satisfied REQUIRED public contracts
 *   4. contractsSatisfied          (DESC) — satisfied public contracts (any strength)
 *   5. familyRank                  (DESC) — candidate honored its typed family witness
 *   6. sourceFiles                 (ASC)  — minimality: distinct source files touched
 *   7. addedLines                  (ASC)  — minimality: added source lines
 *   8. newDefs                     (ASC)  — minimality: new def/class count
 *   9. newFiles                    (ASC)  — minimality: new files created
 *  10. order                       (ASC)  — original candidate index, stable tie-break
 *
 * This module is PURE: no I/O, no clocks, no randomness, no imports. Given the
 * same input it always returns the same result.
 */

export interface LexTiers {
  /** SCAFF-06 executable PUBLIC-issue MWE verdict: +1 candidate provably fixes a
   *  base-red MWE, -1 it provably fails one, 0 none/infra/absent. higher wins.
   *  OPTIONAL + treated as 0 when absent ⇒ purely additive top tier (selection
   *  byte-identical until a real MWE execution populates receipts). */
  readonly mweProof?: -1 | 0 | 1
  /** validated repro consensus strength votes/k; 0 when no validated repro. higher wins. */
  readonly proofStrength: number
  /** 1 = a clean EXECUTED keep-green witness suite passed; 0 = none executed. higher wins. */
  readonly executedKeepGreen: 0 | 1
  /** count of satisfied REQUIRED public contracts. higher wins. */
  readonly requiredContractsSatisfied: number
  /** count of satisfied public contracts (any strength). higher wins. */
  readonly contractsSatisfied: number
  /** 1 = candidate honored its typed family witness; 0 = no family witness. higher wins. */
  readonly familyRank: number
  /** distinct source files touched. SMALLER wins. */
  readonly sourceFiles: number
  /** added source lines. SMALLER wins. */
  readonly addedLines: number
  /** new def/class count. SMALLER wins. */
  readonly newDefs: number
  /** new files created. SMALLER wins. */
  readonly newFiles: number
  /** original candidate index; SMALLER wins the final deterministic tie. */
  readonly order: number
}

export interface LexCandidate {
  readonly id: string
  readonly admissible: boolean
  readonly tiers: LexTiers
}

/**
 * Strict lexicographic comparator over the authority lattice.
 *
 * Returns a negative number if `a` is the better (winning) candidate, a positive
 * number if `b` is better, and 0 only when every tier is identical. Comparison is
 * tier-by-tier: the first differing tier decides, so a later tier can NEVER
 * overturn an earlier one. This is the whole point — minimality (a late tier)
 * cannot beat stronger proof / contracts / family (early tiers).
 */
export const compareLexTiers = (a: LexTiers, b: LexTiers): number => {
  // DESC tiers: the larger value is better, so the better candidate sorts first
  // (negative). We compute (b - a) so a larger `a` yields a negative result.

  // SCAFF-06 top tier — executable public-MWE verdict. Absent ⇒ 0, so a pair of
  // receipt-less candidates compares EXACTLY as before (the field never flips the
  // result until a real MWE execution populates it).
  const mwe = (b.mweProof ?? 0) - (a.mweProof ?? 0)
  if (mwe !== 0) return mwe

  const proof = b.proofStrength - a.proofStrength
  if (proof !== 0) return proof

  const keepGreen = b.executedKeepGreen - a.executedKeepGreen
  if (keepGreen !== 0) return keepGreen

  const required = b.requiredContractsSatisfied - a.requiredContractsSatisfied
  if (required !== 0) return required

  const contracts = b.contractsSatisfied - a.contractsSatisfied
  if (contracts !== 0) return contracts

  const family = b.familyRank - a.familyRank
  if (family !== 0) return family

  // ASC tiers: the smaller value is better. We compute (a - b) so a smaller `a`
  // yields a negative result.
  const files = a.sourceFiles - b.sourceFiles
  if (files !== 0) return files

  const lines = a.addedLines - b.addedLines
  if (lines !== 0) return lines

  const defs = a.newDefs - b.newDefs
  if (defs !== 0) return defs

  const newFiles = a.newFiles - b.newFiles
  if (newFiles !== 0) return newFiles

  return a.order - b.order
}

/**
 * Select the single winning candidate id by strict lexicographic authority.
 *
 * 1. Only ADMISSIBLE candidates are eligible. If none are admissible the caller
 *    must handle best-effort separately, so we return `null`.
 * 2. Among admissible candidates pick the maximum by {@link compareLexTiers}.
 *    The `order` final tie-break makes the result fully deterministic and stable
 *    across repeated calls.
 */
export const selectLexicographic = (cands: readonly LexCandidate[]): string | null => {
  let best: LexCandidate | null = null
  for (const cand of cands) {
    if (!cand.admissible) continue
    if (best === null || compareLexTiers(cand.tiers, best.tiers) < 0) {
      best = cand
    }
  }
  return best === null ? null : best.id
}
