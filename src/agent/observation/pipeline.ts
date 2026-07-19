/**
 * Observation pipeline (jul-6 S3). Design SSOT:
 * `docs/plans/jul-6-observation-providers/README.md` (§3).
 *
 * `gatherObservations(providers, ctx, policy)`:
 *   1. filter by `applicable(ctx)` (non-applicable providers are NEVER produced),
 *   2. run `produce(ctx, budget)` for the survivors (budget from policy),
 *   3. merge/rank/dedup owners:
 *        - rank by SOURCE authority (policy order; e.g. static def-use > lsp > llm),
 *          STABLE within equal authority (preserves each provider's own ranking),
 *        - dedup by (file, symbol) — the higher-authority owner wins,
 *        - NO numeric-confidence merge (B2): there is no number to merge.
 *   4. cap total owners at `budget.maxOwners`,
 *   5. return an `ObservationBundle` (contributors = ids that produced ≥1 owner).
 *
 * The pipeline is pure over its providers/policy: all I/O is inside `produce`.
 */

import type { ObservationBundle, ObservationFragment, OwnerHint } from "./fragment"
import type { ObservationProvider, ProviderBudget, TaskContext } from "./port"

/** Source-authority order, highest first. Static def-use outranks LSP outranks
 *  the LLM localizer (an ordinal policy, NOT a number on the fragment — B2).
 *  Unknown sources sort AFTER all known ones (see `authorityRank`). */
export const DEFAULT_SOURCE_AUTHORITY: readonly string[] = [
  "static-owner",
  "callgraph-impact",
  "scope-guard",
  "lsp-prefetch",
  "git-history",
  "agentless-localize",
  "external-mcp",
]

/** Policy: which sources rank how, and the per-provider budget. */
export interface ObservationPolicy {
  /** Source ids highest-authority first. A source not in the list ranks last. */
  readonly authority: readonly string[]
  /** Per-provider budget + the total owner cap. Defaults are latency-safe. */
  readonly budget?: ProviderBudget
}

/** Per-provider observation-gather wall-clock cap. 5s keeps a slow provider
 *  (e.g. a cold language server in lsp-enrich) from stalling the turn's
 *  pre-prompt enrichment while still allowing a normal warm harvest to finish. */
const DEFAULT_PROVIDER_BUDGET_MS = 5_000
/** Max owners returned per provider before the gather stops harvesting — keeps
 *  the ranked owner list bounded and the merged bundle small. */
const DEFAULT_PROVIDER_MAX_OWNERS = 8
const DEFAULT_BUDGET: ProviderBudget = {
  maxMillis: DEFAULT_PROVIDER_BUDGET_MS,
  maxOwners: DEFAULT_PROVIDER_MAX_OWNERS,
}

/** Rank of a source id — lower is higher authority. Unknown ⇒ length (last),
 *  but still deterministic (registration order is the only tiebreak). */
const authorityRank = (source: string, authority: readonly string[]): number => {
  const idx = authority.indexOf(source)
  return idx === -1 ? authority.length : idx
}

/** Dedup key for an owner. File-only and file+symbol are DISTINCT keys — a
 *  file-level hint and a symbol-level hint are different claims. */
const ownerKey = (o: OwnerHint): string => `${o.file}\x00${o.symbol ?? ""}`

/**
 * Merge/rank/dedup the produced fragments' owners into a ranked, deduped list.
 * STABLE: within equal source authority, provider order (then owner order) is
 * preserved — this is what keeps a single agentless provider's ranking intact
 * (byte-identity precondition).
 */
const mergeOwners = (
  fragments: readonly ObservationFragment[],
  authority: readonly string[],
  maxOwners: number,
): OwnerHint[] => {
  // Flatten with a stable input index so the sort tiebreak is deterministic.
  const flat: { owner: OwnerHint; seq: number }[] = []
  let seq = 0
  for (const frag of fragments) {
    for (const o of frag.owners ?? []) flat.push({ owner: o, seq: seq++ })
  }
  // Stable sort by authority; equal authority ⇒ original sequence (stable).
  flat.sort((a, b) => {
    const ra = authorityRank(a.owner.source, authority)
    const rb = authorityRank(b.owner.source, authority)
    if (ra !== rb) return ra - rb
    return a.seq - b.seq
  })
  // Dedup by (file,symbol): the FIRST occurrence (= highest authority, earliest)
  // wins. NO numeric merge — the winning owner is kept whole.
  const seen = new Set<string>()
  const out: OwnerHint[] = []
  for (const { owner } of flat) {
    const key = ownerKey(owner)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(owner)
    if (out.length >= maxOwners) break
  }
  return out
}

/** First defined value across fragments (impact/scope are single-surface). */
const firstDefined = <T>(
  fragments: readonly ObservationFragment[],
  pick: (f: ObservationFragment) => T | undefined,
): T | undefined => {
  for (const f of fragments) {
    const v = pick(f)
    if (v !== undefined) return v
  }
  return undefined
}

export const gatherObservations = async (
  providers: readonly ObservationProvider[],
  ctx: TaskContext,
  policy: ObservationPolicy,
): Promise<ObservationBundle> => {
  const budget = policy.budget ?? DEFAULT_BUDGET
  // 1. applicable gate — non-applicable providers are NEVER produced.
  const active = providers.filter((p) => p.applicable(ctx))
  // 2. produce (parallel, budget-bounded per provider).
  const produced = await Promise.all(active.map((p) => p.produce(ctx, budget)))

  const fragments: ObservationFragment[] = []
  const contributors: string[] = []
  for (const frag of produced) {
    if (frag === null) continue
    // A fragment that carries no surface at all contributes nothing.
    const hasSurface =
      (frag.owners?.length ?? 0) > 0 ||
      frag.impact !== undefined ||
      frag.scope !== undefined ||
      (frag.contracts?.length ?? 0) > 0
    if (!hasSurface) continue
    fragments.push(frag)
    // Attribution: any provider whose fragment carries a surface contributed.
    contributors.push(frag.providerId)
  }

  const owners = mergeOwners(fragments, policy.authority, budget.maxOwners)
  const impact = firstDefined(fragments, (f) => f.impact)
  const scope = firstDefined(fragments, (f) => f.scope)
  const contracts = firstDefined(fragments, (f) => f.contracts)

  return {
    owners,
    ...(impact !== undefined ? { impact } : {}),
    ...(scope !== undefined ? { scope } : {}),
    ...(contracts !== undefined ? { contracts } : {}),
    contributors,
  }
}
