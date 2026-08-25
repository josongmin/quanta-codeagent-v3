/**
 * T-101 — closure diagnostic rail (OFFLINE sidecar).
 *
 * Computes "closure quality" metrics for a bench run BEFORE any score claim:
 * owner recall, first-edit owner match, stray-file rate, no-patch exhaustion,
 * and (once later waves instrument them) gate/verify/primary-rail metrics.
 *
 * ⚠️ EVAL-ONLY. The {@link ClosureOracle} (gold files / FAIL_TO_PASS) is a
 * post-hoc measurement input. This module MUST NOT be imported by any runtime
 * routing / prompt-rendering path — it exists purely to score a finished run.
 * The compute layer is a PURE function over in-memory facts (no fs, no env) so
 * it is unit-testable and can never leak the oracle into the agent loop.
 *
 * Metrics not yet instrumented by the current driver degrade to
 * `{ available: false, value: null }` — never an invented number. They flip to
 * available automatically once the corresponding `ClosureRunFact` field is
 * populated by a later wave (T-202 firstEdit, T-301/T-302 gate/verify, etc.).
 */

/** Post-hoc gold signal for one instance. EVAL-ONLY — never a runtime input. */
export interface ClosureOracle {
  instanceId: string
  /** Repo-relative paths the gold patch touched (the true owner set). */
  goldFiles: readonly string[]
  failToPass: readonly string[]
}

/**
 * Run-derived facts for one instance (NO oracle). Fields typed `| null` /
 * optional are populated by later waves; absent ⇒ that metric is "unavailable".
 */
export interface ClosureRunFact {
  instanceId: string
  /** Grader verdict; null when the instance was not graded. */
  resolved: boolean | null
  /** Repo-relative files in the agent's final patch, in diff order. */
  patchFiles: readonly string[]
  /** Subset of the patch that is out-of-scope junk (e.g. created `test.html.Z`). */
  strayFiles: readonly string[]
  emptyPatch: boolean
  /** `session_end.reason` (e.g. "max_turns", "completed", "aborted"). */
  endReason: string | null
  /** First mutating tool_call target path (stream-tap, T-202). null ⇒ uncaptured. */
  firstEditFile?: string | null
  /** F6 — count of file-mutating tool_calls (churn). null ⇒ uncaptured. */
  editCount?: number | null
  /** F6 — turn index of the first mutating edit (localize latency). null ⇒ uncaptured. */
  turnsToFirstEdit?: number | null
  /** F6 — agent had a base-RED reproduction available (repro-test reproduced).
   *  Pairs with `resolved` to surface the #10914-class signal: a working repro
   *  yet an unresolved miss (execution feedback present, localize still wrong). */
  reproReproduced?: boolean | null
  // ── later-wave instrumentation (absent until wired) ──────────────────────
  gateEntered?: boolean | null
  gateBypassed?: boolean | null
  verifyRounds?: number | null
  synthReproBaseRed?: boolean | null
  /** jun-30 SOTA++ — winning acceptance rerank tier (observe-only). null ⇒ legacy
   *  validator-rank (acceptance opt-in off / no candidates routed through ladder). */
  acceptanceTier?: import("./acceptance-rerank").RerankTier | null
  primaryRailPresent?: boolean | null
  primaryFalseGreen?: boolean | null
  primaryFalseRed?: boolean | null
  requiredVerificationCovered?: boolean | null
  outOfScopeFiles?: boolean | null
  overBudget?: boolean | null
  newDef?: boolean | null
  crossFile?: boolean | null
}

export type InstanceClass =
  | "resolved"
  | "model_miss"
  | "admission_blocked"
  | "no_patch_exhausted"
  | "empty_patch_other"
  | "ungraded"

export interface ClosureMetric {
  /** Mean over the available denominator, or null when unavailable. */
  value: number | null
  /** True iff at least one instance contributed (denominator > 0). */
  available: boolean
  /** Denominator size. */
  n: number
}

export interface ClosurePerInstance {
  instanceId: string
  class: InstanceClass
  /** null when no oracle / no patch to judge. */
  ownerHit: boolean | null
  firstEditOwnerMatch: boolean | null
  /** Fraction of gold files the agent touched. null when no oracle / no patch. */
  goldCoverage: number | null
  /** `exact` = same file set, `partial` = some overlap but incomplete / extra,
   *  `disjoint` = no overlap. null when no oracle / no patch. */
  goldCoverageClass: "exact" | "partial" | "disjoint" | null
  /** jun-19 — resolution + budget facts per instance so the over-budget ∩
   *  unresolved correlation (the escalation-justification) is readable directly
   *  from the sidecar (no separate report.json join). null ⇒ unavailable. */
  resolved: boolean | null
  overBudget: boolean | null
  newDef: boolean | null
  crossFile: boolean | null
}

export interface ClosureDiagnostics {
  total: number
  metrics: Record<string, ClosureMetric>
  perInstance: ClosurePerInstance[]
}

/** Mean of present (non-null/undefined) values; booleans count as 0/1. */
const metricOf = (vals: ReadonlyArray<boolean | number | null | undefined>): ClosureMetric => {
  const present = vals.filter((v): v is boolean | number => v !== null && v !== undefined)
  if (present.length === 0) return { value: null, available: false, n: 0 }
  const sum = present.reduce<number>((a, v) => a + (typeof v === "boolean" ? (v ? 1 : 0) : v), 0)
  return { value: sum / present.length, available: true, n: present.length }
}

const classify = (f: ClosureRunFact): InstanceClass => {
  if (f.emptyPatch) {
    if (f.endReason === "admission_blocked") return "admission_blocked"
    return f.endReason === "max_turns" || f.endReason === "budget_exhausted"
      ? "no_patch_exhausted"
      : "empty_patch_other"
  }
  if (f.resolved === true) return "resolved"
  if (f.resolved === false) return "model_miss"
  return "ungraded"
}

const overlapCount = (patchFiles: readonly string[], gold: ReadonlySet<string>): number =>
  patchFiles.filter((file) => gold.has(file)).length

const sameFileSet = (patchFiles: readonly string[], goldFiles: readonly string[]): boolean => {
  if (patchFiles.length !== goldFiles.length) return false
  const gold = new Set(goldFiles)
  return patchFiles.every((file) => gold.has(file))
}

/** Fraction of gold files the agent touched. Null when there is no oracle, no
 *  patch, or an empty gold set — never an invented 0. */
const goldCoverageOf = (
  patchFiles: readonly string[],
  oracle: ClosureOracle | undefined,
): number | null => {
  if (oracle === undefined || patchFiles.length === 0 || oracle.goldFiles.length === 0) return null
  return overlapCount(patchFiles, new Set(oracle.goldFiles)) / oracle.goldFiles.length
}

/** Coarse coverage verdict. Its own unit next to {@link goldCoverageOf} because
 *  the two answer the same question at different resolutions and previously
 *  restated the identical `no oracle / no patch` guard in two different shapes
 *  (a 4-term `&&` and a 3-term `||`), which is how they could drift apart. */
const goldCoverageClassOf = (
  patchFiles: readonly string[],
  oracle: ClosureOracle | undefined,
): "exact" | "partial" | "disjoint" | null => {
  if (oracle === undefined || patchFiles.length === 0) return null
  if (sameFileSet(patchFiles, oracle.goldFiles)) return "exact"
  return overlapCount(patchFiles, new Set(oracle.goldFiles)) > 0 ? "partial" : "disjoint"
}

/** One per-instance diagnostic row. `oracle` is passed in (rather than looked up)
 *  so this stays a pure projection of (fact, oracle) with no map in scope. */
const perInstanceRecord = (
  f: ClosureRunFact,
  oracle: ClosureOracle | undefined,
): ClosurePerInstance => {
  const gold = oracle ? new Set(oracle.goldFiles) : null
  return {
    instanceId: f.instanceId,
    class: classify(f),
    ownerHit: gold && f.patchFiles.length > 0 ? gold.has(f.patchFiles[0] as string) : null,
    firstEditOwnerMatch: gold && f.firstEditFile != null ? gold.has(f.firstEditFile) : null,
    goldCoverage: goldCoverageOf(f.patchFiles, oracle),
    goldCoverageClass: goldCoverageClassOf(f.patchFiles, oracle),
    resolved: f.resolved,
    overBudget: f.overBudget ?? null,
    newDef: f.newDef ?? null,
    crossFile: f.crossFile ?? null,
  }
}

/**
 * The metric family that JOINS facts against the oracle. Split from the plain
 * per-field means below because only these need a denominator restricted to
 * instances that HAVE an oracle — the restriction is stated once here per
 * denominator instead of being re-derived inside each metric's `.map`.
 */
const oracleJoinedMetrics = (
  facts: ReadonlyArray<ClosureRunFact>,
  oracleMap: ReadonlyMap<string, ClosureOracle>,
): Record<string, ClosureMetric> => {
  const goldSetOf = (id: string): Set<string> | null => {
    const o = oracleMap.get(id)
    return o ? new Set(o.goldFiles) : null
  }
  // Owner recall over patch-bearing instances that have an oracle.
  const owned = facts.filter((f) => f.patchFiles.length > 0 && oracleMap.has(f.instanceId))
  const multiFileOwned = owned.filter(
    (f) => (oracleMap.get(f.instanceId)?.goldFiles.length ?? 0) > 1,
  )
  const firstEditDenom = facts.filter((f) => f.firstEditFile != null && oracleMap.has(f.instanceId))
  const recallAt = (k: number): ClosureMetric =>
    metricOf(
      owned.map((f) => {
        const gold = goldSetOf(f.instanceId) as Set<string>
        return f.patchFiles.slice(0, k).some((p) => gold.has(p))
      }),
    )
  /** Gold-overlap count for an OWNED fact (its oracle is known to exist). */
  const ownedOverlap = (f: ClosureRunFact): number => {
    const oracle = oracleMap.get(f.instanceId) as ClosureOracle
    return overlapCount(f.patchFiles, new Set(oracle.goldFiles))
  }
  const goldLen = (f: ClosureRunFact): number =>
    (oracleMap.get(f.instanceId) as ClosureOracle).goldFiles.length

  return {
    "owner_recall@1": recallAt(1),
    "owner_recall@3": recallAt(3),
    gold_coverage_rate: metricOf(
      owned.map((f) => goldCoverageOf(f.patchFiles, oracleMap.get(f.instanceId))),
    ),
    exact_file_set_match_rate: metricOf(
      owned.map((f) =>
        sameFileSet(f.patchFiles, (oracleMap.get(f.instanceId) as ClosureOracle).goldFiles),
      ),
    ),
    multi_file_full_coverage_rate: metricOf(
      multiFileOwned.map((f) => ownedOverlap(f) === goldLen(f)),
    ),
    multi_file_partial_overlap_rate: metricOf(
      multiFileOwned.map((f) => {
        const overlap = ownedOverlap(f)
        return overlap > 0 && overlap < goldLen(f)
      }),
    ),
    multi_file_disjoint_rate: metricOf(multiFileOwned.map((f) => ownedOverlap(f) === 0)),
    first_edit_owner_match: metricOf(
      firstEditDenom.map((f) =>
        (goldSetOf(f.instanceId) as Set<string>).has(f.firstEditFile as string),
      ),
    ),
  }
}

/**
 * jun-30 SOTA++ acceptance tier DISTRIBUTION — each rate's denominator (n) is
 * the runs whose selection routed through the rerank ladder (acceptanceTier !=
 * null); legacy validator-rank runs map to null ⇒ excluded. `all_patches`
 * dominance ⇒ the oracle gave no real selection signal (thin-oracle inert).
 */
const acceptanceTierMetrics = (
  facts: ReadonlyArray<ClosureRunFact>,
): Record<string, ClosureMetric> =>
  Object.fromEntries(
    (["repro_and_regression", "regression_only", "all_patches", "none"] as const).map(
      (tier) =>
        [
          `acceptance_tier_${tier}_rate`,
          metricOf(facts.map((f) => (f.acceptanceTier == null ? null : f.acceptanceTier === tier))),
        ] as const,
    ),
  )

/**
 * Pure compute over (run facts, eval oracle). Deterministic, fs/env-free.
 * `oracleMap` keyed by instanceId; instances without an oracle entry are
 * excluded from owner-recall denominators (we can't judge owner without gold).
 */
export const computeClosureDiagnostics = (
  facts: ReadonlyArray<ClosureRunFact>,
  oracleMap: ReadonlyMap<string, ClosureOracle>,
): ClosureDiagnostics => {
  const perInstance: ClosurePerInstance[] = facts.map((f) =>
    perInstanceRecord(f, oracleMap.get(f.instanceId)),
  )

  const patchBearing = facts.filter((f) => f.patchFiles.length > 0)
  // F6 — #10914-class churn: among runs that HAD a reproduced (base-RED) repro,
  // the fraction that still ended unresolved. A raw rate, NOT a thresholded
  // judgement — execution feedback was present yet the miss survived (the signal
  // that localize, not fix-precision, was the bottleneck).
  const reproRedDenom = facts.filter((f) => f.reproReproduced === true && f.resolved !== null)

  const metrics: Record<string, ClosureMetric> = {
    ...oracleJoinedMetrics(facts, oracleMap),
    stray_file_rate: metricOf(patchBearing.map((f) => f.strayFiles.length > 0)),
    admission_blocked_rate: metricOf(perInstance.map((p) => p.class === "admission_blocked")),
    no_patch_exhausted_rate: metricOf(perInstance.map((p) => p.class === "no_patch_exhausted")),
    // F6 exploration-efficiency (raw means / rate — no arbitrary thresholds):
    edit_count_per_run: metricOf(facts.map((f) => f.editCount)),
    turns_to_first_edit: metricOf(facts.map((f) => f.turnsToFirstEdit)),
    repro_red_but_unresolved_rate: metricOf(reproRedDenom.map((f) => f.resolved === false)),
    // later-wave instrumentation — unavailable until the driver populates the field
    primary_rail_present_rate: metricOf(facts.map((f) => f.primaryRailPresent)),
    primary_false_green_rate: metricOf(facts.map((f) => f.primaryFalseGreen)),
    primary_false_red_rate: metricOf(facts.map((f) => f.primaryFalseRed)),
    over_budget_rate: metricOf(facts.map((f) => f.overBudget)),
    new_def_rate: metricOf(facts.map((f) => f.newDef)),
    cross_file_rate: metricOf(facts.map((f) => f.crossFile)),
    required_verification_coverage: metricOf(facts.map((f) => f.requiredVerificationCovered)),
    gate_enter_rate: metricOf(facts.map((f) => f.gateEntered)),
    gate_bypass_rate: metricOf(facts.map((f) => f.gateBypassed)),
    verify_rounds_per_run: metricOf(facts.map((f) => f.verifyRounds)),
    synth_repro_base_red_rate: metricOf(facts.map((f) => f.synthReproBaseRed)),
    out_of_scope_file_rate: metricOf(facts.map((f) => f.outOfScopeFiles)),
    ...acceptanceTierMetrics(facts),
  }

  return { total: facts.length, metrics, perInstance }
}
