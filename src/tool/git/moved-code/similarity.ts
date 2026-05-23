/**
 * Weighted Jaccard similarity over token multisets (ADR-0109).
 *
 * Why weighted Jaccard (over Levenshtein):
 *   - O(N+M) build (count) + O(K) compare (K = distinct tokens). Levenshtein
 *     is O(N×M) per pair — for big PRs (N hunks × M hunks × N×M lines each)
 *     this dominates. Jaccard is the only realistic O choice.
 *   - Reorder-invariant. A function body whose statements got shuffled but
 *     not edited still matches as moved (Levenshtein would penalize).
 *   - Codex + Cursor both use token-set similarity in their move
 *     detection — well-validated against real PR review noise.
 *
 * Weighted variant (vs set Jaccard):
 *   - sum(min) / sum(max) per token across two multisets. A 5×`return`
 *     block matched against another 5×`return` block scores high; a
 *     5×`return` block matched against 1×`return` block scores lower
 *     (correct — different "weight" of the same identifier).
 *
 * Output range [0, 1] — 1.0 means identical multisets (modulo
 * normalization), 0.0 means disjoint. Empty input on either side ⇒ 0.0
 * (matcher then rejects via {@link ClassifyOptions.minSimilarity}).
 */

import { tokenize } from "./normalize"

/** Build a count map (multiset) over tokens. Pure. */
const toCounts = (tokens: readonly string[]): Map<string, number> => {
  const m = new Map<string, number>()
  for (const t of tokens) {
    m.set(t, (m.get(t) ?? 0) + 1)
  }
  return m
}

/** Weighted Jaccard over two token multisets. Returns 0.0 when either side
 *  is empty (no signal to compute on). */
export const weightedJaccard = (a: readonly string[], b: readonly string[]): number => {
  if (a.length === 0 || b.length === 0) return 0
  const ca = toCounts(a)
  const cb = toCounts(b)
  let intersection = 0
  let union = 0
  // Union of distinct tokens = keys(ca) ∪ keys(cb). Walk both, but count
  // each distinct token exactly once for the denominator.
  const visited = new Set<string>()
  for (const [tok, na] of ca) {
    const nb = cb.get(tok) ?? 0
    intersection += Math.min(na, nb)
    union += Math.max(na, nb)
    visited.add(tok)
  }
  for (const [tok, nb] of cb) {
    if (visited.has(tok)) continue
    // tok appears only in b — adds nb to the union (max with implicit 0 in a).
    union += nb
  }
  return union === 0 ? 0 : intersection / union
}

/** Convenience: tokenize two bodies and return the weighted Jaccard. */
export const bodySimilarity = (bodyA: string, bodyB: string): number =>
  weightedJaccard(tokenize(bodyA), tokenize(bodyB))
