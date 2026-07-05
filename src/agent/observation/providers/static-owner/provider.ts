/**
 * static-owner PROVIDER (jul-6 S2). Design SSOT:
 * `docs/plans/jul-6-observation-providers/README.md` (§1, 페이징 P1b).
 *
 * An `ObservationProvider` (kind "localization") backed by the def-use
 * {@link StaticOwnerEngine}. It maps engine facts → typed `OwnerHint`s. It does
 * NOT render (S3 owns rendering) and is NOT wired into the injection seam (main
 * wires later); this is the pure produce leaf.
 *
 * HARD invariants (audit-derived):
 *   - A1 overtrust: `strength` is the engine fact's ordinal verbatim; the
 *     provider NEVER upgrades it and NEVER fabricates a "high".
 *   - hallucination double-fence: an emitted owner.file MUST be in ctx.repoFiles
 *     even if a broken engine leaked a path (the engine fences too — belt AND
 *     braces).
 *   - null-not-noise: no surviving owner ⇒ `produce` returns `null` (never an
 *     empty-owners fragment — that would render noise in S3).
 *   - `applicable` gates on capability "source-repair" AND an engine-supported
 *     language. Pure.
 *   - budget-bounded: owners capped at `budget.maxOwners`.
 *   - PURE leaf: no @/llm, no IO, no env.
 */

import type { EvidenceStrength, ObservationFragment, OwnerHint } from "../../fragment"
import type { ObservationProvider, ProviderBudget, TaskContext } from "../../port"
import type { StaticOwnerEngine, StaticOwnerFact } from "./engine"

const PROVIDER_ID = "static-owner"

/** Map one engine fact → an OwnerHint. `strength` is passed through verbatim
 *  (A1: no upgrade). `evidence` = the def-use basis. `source` = provider id. */
const factToOwner = (fact: StaticOwnerFact): OwnerHint => {
  const strength: EvidenceStrength = fact.strength
  const base: OwnerHint = {
    file: fact.file,
    strength,
    evidence: fact.basis,
    source: PROVIDER_ID,
  }
  return fact.symbol !== undefined ? { ...base, symbol: fact.symbol } : base
}

/** Admit a fact as an owner iff its file is in-tree AND it has an observed
 *  basis. Double-fence (hallucination) + A1 (no basis ⇒ no signal). Pure. */
const admits = (fact: StaticOwnerFact, allowed: ReadonlySet<string>): boolean =>
  allowed.has(fact.file) && fact.basis.trim().length > 0

/** Map engine facts → owners, fenced against `repoFiles` and capped at
 *  `maxOwners`. Engine order is the authority; the first `maxOwners` admitted
 *  facts survive. Pure. */
const selectOwners = (
  facts: readonly StaticOwnerFact[],
  repoFiles: readonly string[],
  maxOwners: number,
): OwnerHint[] => {
  const allowed = new Set(repoFiles)
  const owners: OwnerHint[] = []
  for (const fact of facts) {
    if (owners.length >= maxOwners) break
    if (admits(fact, allowed)) owners.push(factToOwner(fact))
  }
  return owners
}

export const staticOwnerProvider = (engine: StaticOwnerEngine): ObservationProvider => ({
  id: PROVIDER_ID,
  kind: "localization",

  applicable: (ctx: TaskContext): boolean => {
    if (ctx.capability !== "source-repair") return false
    if (ctx.language === undefined) return false
    return engine.supportsLanguage(ctx.language)
  },

  produce: async (
    ctx: TaskContext,
    budget: ProviderBudget,
  ): Promise<ObservationFragment | null> => {
    // Non-positive budget ⇒ no room to say anything ⇒ no signal.
    if (!Number.isFinite(budget.maxOwners) || budget.maxOwners < 1) return null

    const facts = engine.owners({
      issueText: ctx.issueText,
      repoFiles: ctx.repoFiles,
      ...(ctx.language !== undefined ? { language: ctx.language } : {}),
    })

    // Double-fence (hallucination) + A1 (empty-basis drop) + budget cap.
    const owners = selectOwners(facts, ctx.repoFiles, budget.maxOwners)

    // null-not-noise: no surviving owner ⇒ no fragment at all.
    if (owners.length === 0) return null

    return { providerId: PROVIDER_ID, owners }
  },
})
