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
    return f.endReason === "max_turns" ? "no_patch_exhausted" : "empty_patch_other"
  }
  if (f.resolved === true) return "resolved"
  if (f.resolved === false) return "model_miss"
  return "ungraded"
}

/**
 * Pure compute over (run facts, eval oracle). Deterministic, fs/env-free.
 * `oracleMap` keyed by instanceId; instances without an oracle entry are
 * excluded from owner-recall denominators (we can't judge owner without gold).
 */
export const computeClosureDiagnostics = (
  facts: ReadonlyArray<ClosureRunFact>,
  oracleMap: ReadonlyMap<string, ClosureOracle>,
): ClosureDiagnostics => {
  const goldSetOf = (id: string): Set<string> | null => {
    const o = oracleMap.get(id)
    return o ? new Set(o.goldFiles) : null
  }

  const perInstance: ClosurePerInstance[] = facts.map((f) => {
    const gold = goldSetOf(f.instanceId)
    const ownerHit = gold && f.patchFiles.length > 0 ? gold.has(f.patchFiles[0] as string) : null
    const firstEditOwnerMatch = gold && f.firstEditFile != null ? gold.has(f.firstEditFile) : null
    return {
      instanceId: f.instanceId,
      class: classify(f),
      ownerHit,
      firstEditOwnerMatch,
      resolved: f.resolved,
      overBudget: f.overBudget ?? null,
      newDef: f.newDef ?? null,
      crossFile: f.crossFile ?? null,
    }
  })

  // Owner recall over patch-bearing instances that have an oracle.
  const owned = facts.filter((f) => f.patchFiles.length > 0 && oracleMap.has(f.instanceId))
  const recallAt = (k: number): ClosureMetric =>
    metricOf(
      owned.map((f) => {
        const gold = goldSetOf(f.instanceId) as Set<string>
        return f.patchFiles.slice(0, k).some((p) => gold.has(p))
      }),
    )

  const patchBearing = facts.filter((f) => f.patchFiles.length > 0)
  const firstEditDenom = facts.filter((f) => f.firstEditFile != null && oracleMap.has(f.instanceId))
  // F6 — #10914-class churn: among runs that HAD a reproduced (base-RED) repro,
  // the fraction that still ended unresolved. A raw rate, NOT a thresholded
  // judgement — execution feedback was present yet the miss survived (the signal
  // that localize, not fix-precision, was the bottleneck).
  const reproRedDenom = facts.filter((f) => f.reproReproduced === true && f.resolved !== null)

  const metrics: Record<string, ClosureMetric> = {
    "owner_recall@1": recallAt(1),
    "owner_recall@3": recallAt(3),
    first_edit_owner_match: metricOf(
      firstEditDenom.map((f) =>
        (goldSetOf(f.instanceId) as Set<string>).has(f.firstEditFile as string),
      ),
    ),
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
  }

  return { total: facts.length, metrics, perInstance }
}
