/**
 * RFC-12 / ADR-0439 §4.5 — Deterministic 2-tier candidate ranking.
 *
 * NO new fuzzy heuristic (the `no-heuristics-only-validated` rule). This is
 * the SAME prefix-match idiom the slash palette uses
 * (`slash-engine.ts:44`: `vocabulary.filter(startsWith).sort()`), extended
 * with a conservative substring fallback so a mid-name match still surfaces.
 *
 * Tiering (the ONLY ranking signal — no weighted score is invented):
 *   - tier 0 — `value` starts with `query` (case-insensitive).
 *   - tier 1 — `value` merely contains `query` (case-insensitive).
 *   - no match ⇒ filtered out entirely.
 *
 * Stable order: tier ASC, then ORIGINAL input index ASC. Two values in the
 * same tier keep the provider's input order (which is itself deterministic —
 * fs walk / LSP order). Empty `query` ⇒ tier 0 for everything (keep order),
 * matching the slash palette's "no filter ⇒ show all" behaviour.
 */

/** Match tier for one value against `query`. Returns `-1` for no match. */
export const matchTier = (value: string, query: string): number => {
  if (query === "") return 0
  const v = value.toLowerCase()
  const q = query.toLowerCase()
  if (v.startsWith(q)) return 0
  if (v.includes(q)) return 1
  return -1
}

/**
 * Rank `values` against `query`, returning the surviving values in
 * deterministic `(tier, originalIndex)` order. Pure, NO-THROW for string
 * inputs.
 */
export const rankByTier = (
  values: readonly string[],
  query: string,
): readonly { readonly value: string; readonly tier: number; readonly index: number }[] => {
  const scored: { value: string; tier: number; index: number }[] = []
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i] ?? ""
    const tier = matchTier(value, query)
    if (tier < 0) continue
    scored.push({ value, tier, index: i })
  }
  scored.sort((a, b) => (a.tier !== b.tier ? a.tier - b.tier : a.index - b.index))
  return scored
}
