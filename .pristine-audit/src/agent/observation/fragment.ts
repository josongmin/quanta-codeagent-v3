/**
 * Observation kernel — the typed evidence FRAGMENT a provider emits (jul-6).
 *
 * SSOT for the shared shape all providers/renderer/critic consume. Design:
 * `docs/plans/jul-6-observation-providers/README.md` (§2, 3R adversarial-audited).
 *
 * HARD invariants (audit-derived — do NOT reintroduce):
 *   - NO numeric confidence anywhere (B2). Static engines do not emit calibrated
 *     probabilities; cross-provider numeric scales are incomparable. Strength is
 *     an ORDINAL enum only; ranking is a policy-internal rule (source authority +
 *     evidence type + recency), never a number on the fragment.
 *   - Evidence is a ROUTING HINT, never proof (A1/A2). The renderer frames it as
 *     such; providers must fill `evidence` with the OBSERVED basis (e.g. the
 *     def-use edge), not an assertion of ownership.
 */

/** Ordinal evidence strength — replaces numeric confidence. `unknown` when the
 *  provider genuinely cannot rank (never silently coerce to a middle value). */
export type EvidenceStrength = "high" | "medium" | "low" | "unknown"

/** A candidate owning location. `symbol` optional (file-level hint still useful).
 *  `evidence` = the concrete observed basis; `source` = provider id (authority). */
export interface OwnerHint {
  readonly file: string
  readonly symbol?: string
  readonly strength?: EvidenceStrength
  readonly evidence: string
  readonly source: string
}

/** Impact surface (callgraph-derived). Absent fields ⇒ not computed, not "none". */
export interface ImpactHint {
  readonly likelyRuntimePaths: readonly string[]
  readonly riskyCallers: readonly string[]
  readonly testsNotToEdit: readonly string[]
}

/** Allowed / avoided edit scope. MUST share its rule source with the runtime
 *  protect-paths guard (`QUANTA_BENCH_PROTECT_TESTS`) — evidence ⊗ enforcement SSOT. */
export interface ScopeHint {
  readonly allow: readonly string[]
  readonly avoid: readonly string[]
}

/** Adjacent contract the fix must respect (signature / raised exceptions). */
export interface ContractHint {
  readonly signature?: string
  readonly raises?: readonly string[]
  readonly adjacent: string
}

/** One provider's contribution. NO fragment-level numeric confidence (B2) —
 *  ranking/dedup happens in the pipeline policy from `owners[].source`/`strength`. */
export interface ObservationFragment {
  readonly providerId: string
  readonly owners?: readonly OwnerHint[]
  readonly impact?: ImpactHint
  readonly scope?: ScopeHint
  readonly contracts?: readonly ContractHint[]
  readonly notes?: readonly string[]
}

/** Merged, ranked result of a pipeline pass — what the renderer consumes. */
export interface ObservationBundle {
  readonly owners: readonly OwnerHint[]
  readonly impact?: ImpactHint
  readonly scope?: ScopeHint
  readonly contracts?: readonly ContractHint[]
  /** Provider ids that contributed (measurement attribution). */
  readonly contributors: readonly string[]
}
