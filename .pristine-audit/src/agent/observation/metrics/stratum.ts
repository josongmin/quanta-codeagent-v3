/**
 * Observation metrics — `stratumTag` slice classifier (jul-6, Stream S4).
 * Design SSOT: `docs/plans/jul-6-observation-providers/README.md` §실험 설계
 * ("stratified heldout … overtrust 반증 셀").
 *
 * Tags an instance's stratum so the eval can find OVERTRUST-REGRESSION cells:
 * `misleading-hint` / `dynamic-dispatch` are the design's mandatory
 * counter-example slices (A1 regression guard). Pure fn over task metadata —
 * no trajectory, no IO / env / `@/llm`.
 *
 * An instance may belong to SEVERAL strata (returns 0..n labels), e.g. a
 * multi-file lockfile trap. Empty ⇒ no known stratum matched (never guess).
 */

export type StratumTag =
  | "one-file"
  | "multi-file"
  | "ambiguous-owner"
  | "misleading-hint"
  | "dynamic-dispatch"
  | "lockfile-trap"

/**
 * Task metadata the tagger reasons over. All optional so a caller can tag on
 * whatever it has (issue text alone still enables the language-driven slices).
 * Kept plain (no dataset-type leak) so this stays a unit-testable leaf.
 */
export interface StratumInput {
  /** Files in the ground-truth / gold patch (repo-relative). The primary signal. */
  readonly goldPatchFiles?: readonly string[]
  /** Number of distinct suggested owners in the bundle (drives ambiguous-owner). */
  readonly suggestedOwnerCount?: number
  /**
   * Whether the issue/traceback names a file/symbol that is NOT in the gold
   * patch (a red herring) ⇒ the hint is misleading. Caller derives this by
   * comparing the parsed issue-hint target against `goldPatchFiles`.
   */
  readonly hintPointsAwayFromGold?: boolean
  /**
   * Whether resolving the true owner requires dynamic dispatch / reflection
   * (invisible to a static engine) — the design's second overtrust cell.
   */
  readonly requiresDynamicDispatch?: boolean
}

/** Lockfiles / generated dependency manifests — editing these is the trap. */
const LOCKFILE_RE =
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Pipfile\.lock|Cargo\.lock|Gemfile\.lock|composer\.lock|go\.sum|uv\.lock)$/

const isLockfile = (path: string): boolean => LOCKFILE_RE.test(path.replaceAll("\\", "/"))

/**
 * Tag the stratum of an instance. Returns matched labels (0..n), order-stable.
 *
 * - `one-file` / `multi-file` — from the gold patch's distinct file count
 *   (1 ⇒ one-file, ≥2 ⇒ multi-file). Mutually exclusive; absent when the gold
 *   patch is unknown (no guess).
 * - `ambiguous-owner` — ≥2 suggested owners (the model must disambiguate).
 * - `misleading-hint` — caller flagged the parsed hint points away from gold.
 * - `dynamic-dispatch` — caller flagged the true owner needs dynamic dispatch.
 * - `lockfile-trap` — the gold patch touches a lockfile (the edit-the-lock trap).
 */
export const stratumTag = (input: StratumInput): readonly StratumTag[] => {
  const tags: StratumTag[] = []
  const gold = input.goldPatchFiles
  if (gold !== undefined) {
    const distinct = new Set(gold.map((p) => p.replaceAll("\\", "/")))
    if (distinct.size === 1) tags.push("one-file")
    else if (distinct.size >= 2) tags.push("multi-file")
    if ([...distinct].some(isLockfile)) tags.push("lockfile-trap")
  }
  if ((input.suggestedOwnerCount ?? 0) >= 2) tags.push("ambiguous-owner")
  if (input.hintPointsAwayFromGold === true) tags.push("misleading-hint")
  if (input.requiresDynamicDispatch === true) tags.push("dynamic-dispatch")
  return tags
}
