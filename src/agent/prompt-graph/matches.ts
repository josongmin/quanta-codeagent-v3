/**
 * ADR-0538 Phase 1 — the pure `matches()` predicate.
 *
 * PURE + TOTAL: no clock, no IO, no env reads. Exhaustive over the closed facet
 * set declared on {@link AtomMatcher}. An absent facet is "don't care"; every
 * present facet must hold; all present facets AND together. An `undefined`
 * matcher matches every ctx.
 *
 * The exhaustiveness is enforced structurally: the axis-facet loop iterates the
 * `FacetPredicate` facets and the presence-facet loop iterates the booleans;
 * adding a facet to `AtomMatcher` without handling it here is a type error at
 * the destructure below (the `satisfies` guard pins the full key set).
 */

import type { AtomMatcher, FacetPredicate, PromptContext } from "./types"

/** Evaluate one `FacetPredicate` against an axis value. `undefined` axis value
 *  (only `verifyStrategy` can be absent) is treated as a distinct member: a
 *  positive list never contains it (so it does not match), a `{not}` list that
 *  omits it DOES match (absence is not in the excluded set). */
const facetHolds = <T extends string>(
  pred: FacetPredicate<T>,
  value: T | undefined,
): boolean => {
  if (Array.isArray(pred)) {
    return value !== undefined && pred.includes(value)
  }
  const excluded = (pred as { readonly not: readonly T[] }).not
  return value === undefined ? true : !excluded.includes(value)
}

/**
 * True iff the atom's `when` applies to `ctx`. PURE.
 *
 * Absent matcher ⇒ always applies. Otherwise every PRESENT facet must hold:
 *   - axis facets (`envPosture`/`promptPack`/`verifyStrategy`/`mode`) via
 *     {@link facetHolds} (positive membership or `{not}` exclusion);
 *   - presence facets (the `has*` / `brief` / `untrustedEnvelope` booleans)
 *     must equal the ctx's corresponding boolean.
 */
export const matches = (when: AtomMatcher | undefined, ctx: PromptContext): boolean => {
  if (when === undefined) return true

  if (when.envPosture !== undefined && !facetHolds(when.envPosture, ctx.envPosture)) return false
  if (when.promptPack !== undefined && !facetHolds(when.promptPack, ctx.promptPack)) return false
  if (when.verifyStrategy !== undefined && !facetHolds(when.verifyStrategy, ctx.verifyStrategy))
    return false
  if (when.mode !== undefined && !facetHolds(when.mode, ctx.mode)) return false

  // Presence facets — exhaustive over the boolean surface. A `satisfies` on the
  // literal key list makes adding a presence facet to AtomMatcher a compile error
  // here until it is wired below.
  const presenceKeys = [
    "hasRepoRules",
    "hasGlobRules",
    "hasSessionCtx",
    "hasMemorySummary",
    "hasWorkingState",
    "hasActiveSkills",
    "hasContextEvents",
    "hasMentionInjection",
    "hasHookInjects",
    "hasImages",
    "brief",
    "untrustedEnvelope",
  ] as const satisfies ReadonlyArray<keyof AtomMatcher & keyof PromptContext>

  for (const key of presenceKeys) {
    const want = when[key]
    if (want !== undefined && want !== ctx[key]) return false
  }
  return true
}
