/**
 * static-owner SHADOW-mode evaluator (jul-6 S2, design P1). Design SSOT:
 * `docs/plans/jul-6-observation-providers/README.md` (페이징 P1 — SHADOW mode).
 *
 * The PRE-INJECTION precision gate. Given the provider's owners and the files
 * the ACTUAL success patch touched, it computes precision/recall — OFFLINE and
 * OBSERVE-ONLY. Nothing is injected, nothing is shown to the model. This is what
 * lets us block static-owner from EVER feeding a wrong owner: if shadow
 * precision on a heldout is low, injection is never turned on.
 *
 * HARD invariants:
 *   - PURE: (owners × gold-files) → score. Deterministic. No IO / env / llm.
 *   - Distinct-FILE precision/recall (owner symbols/strength are irrelevant —
 *     only file identity is scored; the success patch is a file set).
 *   - Handles empty predicted, empty gold, partial overlap, duplicates,
 *     blank paths — never NaN.
 *   - NO baked-in threshold / gate value here (no-heuristic — the gate value is
 *     decided from measured data elsewhere). This module only REPORTS ratios.
 */

import type { OwnerHint } from "../../fragment"

/** Observe-only precision/recall of provider owners vs the success-patch files.
 *  No numeric confidence — just the counts and the two ratios. */
export interface ShadowScore {
  /** |predicted ∩ gold| / |distinct predicted files|. 0 when nothing predicted. */
  readonly precision: number
  /** |predicted ∩ gold| / |distinct gold files|. 0 when gold is empty. */
  readonly recall: number
  /** Distinct predicted files that are in gold. */
  readonly truePositives: number
  /** Distinct, non-blank predicted files. */
  readonly predictedCount: number
  /** Distinct, non-blank gold files. */
  readonly goldCount: number
}

/** Distinct non-blank file paths (trimmed). Blank/whitespace entries dropped so
 *  they don't inflate denominators. */
const distinctFiles = (paths: readonly string[]): Set<string> => {
  const out = new Set<string>()
  for (const p of paths) {
    const t = typeof p === "string" ? p.trim() : ""
    if (t.length > 0) out.add(t)
  }
  return out
}

/**
 * Pure precision/recall of `providerOwners` (by file) vs
 * `successPatchTouchedFiles`. Precision denominator = distinct predicted files;
 * recall denominator = distinct gold files. Both default to 0 (not NaN) when a
 * denominator is empty — an empty prediction is "0% precise", an empty gold set
 * is "0% recalled".
 */
export const scoreStaticOwnerShadow = (
  providerOwners: readonly OwnerHint[],
  successPatchTouchedFiles: readonly string[],
): ShadowScore => {
  const predicted = distinctFiles(providerOwners.map((o) => o.file))
  const gold = distinctFiles(successPatchTouchedFiles)

  let truePositives = 0
  for (const f of predicted) if (gold.has(f)) truePositives++

  const precision = predicted.size === 0 ? 0 : truePositives / predicted.size
  const recall = gold.size === 0 ? 0 : truePositives / gold.size

  return {
    precision,
    recall,
    truePositives,
    predictedCount: predicted.size,
    goldCount: gold.size,
  }
}
