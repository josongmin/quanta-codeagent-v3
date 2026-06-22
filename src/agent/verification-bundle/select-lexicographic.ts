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
 * Compare two tier values with a TOTAL, transitive, NaN-safe order.
 *
 * The naive `(b - a)` / `(a - b)` + `!== 0` short-circuit is a footgun when any
 * tier value is NaN (e.g. a proofStrength built from a 0/0 ratio): NaN makes the
 * subtraction NaN, every `!== 0` test is false, and the comparator silently falls
 * through to later tiers. That is a NON-TOTAL order — it violates antisymmetry and
 * transitivity, which makes `Array.prototype.sort` behavior undefined.
 *
 * Here NaN is deterministically treated as the WORST possible value regardless of
 * direction: a NaN-bearing candidate always loses this tier to a finite one, and
 * two NaNs tie (so later finite tiers still decide). `dir` is +1 for DESC tiers
 * (larger value wins, i.e. the better candidate sorts first ⇒ negative) and -1 for
 * ASC tiers (smaller value wins).
 *
 * Returns a negative number when `av` is the better value, positive when `bv` is
 * better, and 0 when they tie. Total and antisymmetric for ALL finite/NaN inputs.
 */
const cmpTier = (av: number, bv: number, dir: 1 | -1): number => {
  const aNaN = Number.isNaN(av)
  const bNaN = Number.isNaN(bv)
  if (aNaN || bNaN) {
    if (aNaN && bNaN) return 0 // both worst ⇒ tie, defer to later tiers
    return aNaN ? 1 : -1 // the NaN side is the worst value ⇒ it loses (positive)
  }
  // DESC (dir=+1): better = larger ⇒ (b - a); ASC (dir=-1): better = smaller ⇒ (a - b).
  return dir === 1 ? bv - av : av - bv
}

/**
 * Strict lexicographic comparator over the authority lattice.
 *
 * Returns a negative number if `a` is the better (winning) candidate, a positive
 * number if `b` is better, and 0 only when every tier is identical. Comparison is
 * tier-by-tier: the first differing tier decides, so a later tier can NEVER
 * overturn an earlier one. This is the whole point — minimality (a late tier)
 * cannot beat stronger proof / contracts / family (early tiers).
 *
 * Every tier goes through {@link cmpTier}, which keeps the order TOTAL even if a
 * tier value is NaN (NaN sorts last as the worst value) — a non-total order would
 * make `sort` undefined and could silently corrupt selection.
 */
export const compareLexTiers = (a: LexTiers, b: LexTiers): number => {
  // SCAFF-06 top tier — executable public-MWE verdict. Absent ⇒ 0, so a pair of
  // receipt-less candidates compares EXACTLY as before (the field never flips the
  // result until a real MWE execution populates it).
  const mwe = cmpTier(a.mweProof ?? 0, b.mweProof ?? 0, 1)
  if (mwe !== 0) return mwe

  // DESC authority tiers (larger value is the better, winning candidate).
  const proof = cmpTier(a.proofStrength, b.proofStrength, 1)
  if (proof !== 0) return proof

  const keepGreen = cmpTier(a.executedKeepGreen, b.executedKeepGreen, 1)
  if (keepGreen !== 0) return keepGreen

  const required = cmpTier(a.requiredContractsSatisfied, b.requiredContractsSatisfied, 1)
  if (required !== 0) return required

  const contracts = cmpTier(a.contractsSatisfied, b.contractsSatisfied, 1)
  if (contracts !== 0) return contracts

  const family = cmpTier(a.familyRank, b.familyRank, 1)
  if (family !== 0) return family

  // ASC minimality tiers (smaller value is the better candidate).
  const files = cmpTier(a.sourceFiles, b.sourceFiles, -1)
  if (files !== 0) return files

  const lines = cmpTier(a.addedLines, b.addedLines, -1)
  if (lines !== 0) return lines

  const defs = cmpTier(a.newDefs, b.newDefs, -1)
  if (defs !== 0) return defs

  const newFiles = cmpTier(a.newFiles, b.newFiles, -1)
  if (newFiles !== 0) return newFiles

  return cmpTier(a.order, b.order, -1)
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
