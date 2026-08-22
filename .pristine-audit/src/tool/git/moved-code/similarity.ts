/**
 * Jaccard token similarity for moved-code detection (ADR-0109 §결정).
 *
 * Jaccard chosen over Levenshtein:
 *   - O(N+M) build + O(min(N,M)) intersection, vs O(N×M) for edit distance —
 *     keeps the outer O(|removed|×|added|) loop tractable under the
 *     {@link ClassifyOptions.maxPairs} cap.
 *   - Robust to in-block line reordering on move (a tolerated normalization).
 *   - Multiset semantics: a token that appears 3 times on each side
 *     contributes |intersection|=3, not 1 — so repeating boilerplate
 *     (e.g. `await`) doesn't inflate similarity beyond what's earned.
 *
 * The Codex `apply_patch` matcher and Cursor's code-move heuristics both use
 * token-bag comparisons (not raw edit distance) for the same reason: cheap
 * + robust to whitespace/reorder noise after normalization.
 *
 * Returns 0 when both sides are empty (degenerate; classified as "no match"
 * by the minLines floor anyway).
 */

/** Build a multiset (token → count) from a token list. */
const multiset = (tokens: readonly string[]): Map<string, number> => {
  const m = new Map<string, number>()
  for (const t of tokens) {
    m.set(t, (m.get(t) ?? 0) + 1)
  }
  return m
}

/**
 * Weighted Jaccard over multisets:
 *   sim = Σ min(a[t], b[t])  /  Σ max(a[t], b[t])
 *
 * Both sums range over the union of token universes. Identical multisets ⇒ 1.0;
 * disjoint ⇒ 0.0.
 */
export const jaccardSimilarity = (
  aTokens: readonly string[],
  bTokens: readonly string[],
): number => {
  if (aTokens.length === 0 && bTokens.length === 0) return 0
  const a = multiset(aTokens)
  const b = multiset(bTokens)
  let inter = 0
  let union = 0
  // Iterate union of keys.
  const keys = new Set<string>()
  for (const k of a.keys()) keys.add(k)
  for (const k of b.keys()) keys.add(k)
  for (const k of keys) {
    const av = a.get(k) ?? 0
    const bv = b.get(k) ?? 0
    inter += Math.min(av, bv)
    union += Math.max(av, bv)
  }
  if (union === 0) return 0
  return inter / union
}
