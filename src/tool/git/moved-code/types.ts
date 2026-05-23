/**
 * Moved-code detector types (ADR-0109 — Cursor `pr-review-canvas` algorithm
 * implementation). Closed-port: pure types + a single public seam
 * (`classifyDiff` in `./index.ts`) so the algorithm can be swapped or
 * extended without rippling.
 */

/** A single hunk extracted from a unified diff. Each hunk is one contiguous
 *  block of `+` or `-` lines under one file path. */
export interface DiffHunk {
  readonly file: string
  /** 1-based first line in the hunk (in the post-image for `added`, pre-image
   *  for `removed`). */
  readonly startLine: number
  /** 1-based last line in the hunk (inclusive). */
  readonly endLine: number
  readonly kind: "added" | "removed"
  /** Body lines joined by `\n`. Excludes the diff marker; only the code. */
  readonly body: string
}

/** A detected move — a `removed` block matched to an `added` block above
 *  the configured similarity threshold. The `similarity` field is the
 *  computed score in `[0, 1]`; the `body` is the NORMALIZED form (used by
 *  the matcher) so a caller can render attribution. */
export interface MovedBlock {
  readonly fromFile: string
  readonly fromStartLine: number
  readonly fromEndLine: number
  readonly toFile: string
  readonly toStartLine: number
  readonly toEndLine: number
  readonly similarity: number
  readonly body: string
}

/** Output of {@link classifyDiff}. Closed shape — every input hunk lands in
 *  exactly one category: `logic` (real change, surfaces in the review),
 *  `moved` (relocation, suppressed from the main review), or `mechanical`
 *  (reserved for a future expansion — empty array today). */
export interface DiffClassification {
  readonly logic: readonly DiffHunk[]
  readonly moved: readonly MovedBlock[]
  readonly mechanical: readonly DiffHunk[]
}

/** Tuning knobs for the matcher. Defaults are pinned by ADR-0109 §결정
 *  with justification — they are NOT arbitrary thresholds
 *  ([[no-heuristics-only-validated]] compliance). */
export interface ClassifyOptions {
  /** Minimum lines in BOTH `-` and `+` blocks for a move to count.
   *  Default 5 — defends against short-code false positives where two
   *  unrelated 2-line blocks happen to share their token set. */
  readonly minLines?: number
  /** Minimum weighted-Jaccard similarity for a move to count. Default
   *  0.85 — precision-favored. Override to `0.7` for a more lenient
   *  refactor-tolerant matcher (rename one identifier still detected).
   *  See HELL-14 for the calibration evidence. */
  readonly minSimilarity?: number
  /** Hard cap on pairwise comparisons. Default 10_000 — for a PR with
   *  100 `-` × 100 `+` hunks this is just at the cap; beyond that the
   *  detector returns ALL hunks as logic (no false moves from
   *  combinatorial blow-up). */
  readonly maxPairs?: number
}
