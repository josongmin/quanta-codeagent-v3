/**
 * Moved-code detector — ADR-0109 (PR-review canvas: §2 "moved" category).
 *
 * Public contract types. Pure data shapes — no methods, no `any`, no sentinels.
 * Numeric fields use closed ranges documented in field doc-comments; algorithm
 * details live in {@link ./index.ts}.
 *
 * Slice isolation: this module is consumed by the pr-review-canvas system
 * skill and (future) git_diff post-processing. Detector is pure; no I/O.
 */

/** A single contiguous `-` or `+` hunk from a unified diff. */
export interface DiffHunk {
  /** Relative path inside the repo (post-`b/`-prefix strip). Never empty. */
  readonly file: string
  /** 1-based start line in the source file ("removed") or target file ("added"). */
  readonly startLine: number
  /** 1-based end line (inclusive). `endLine >= startLine` always. */
  readonly endLine: number
  /** Polarity of the hunk. */
  readonly kind: "added" | "removed"
  /** Raw lines of the hunk body, joined by `\n`. NO `+`/`-` prefix. */
  readonly body: string
}

/** A pair of matched `-` and `+` hunks recognized as a moved block. */
export interface MovedBlock {
  readonly fromFile: string
  readonly fromStartLine: number
  readonly fromEndLine: number
  readonly toFile: string
  readonly toStartLine: number
  readonly toEndLine: number
  /** Jaccard token similarity ∈ [0, 1]. ≥ {@link ClassifyOptions.minSimilarity}. */
  readonly similarity: number
  /** Normalized body of the matched block (whitespace-collapsed, blank-line-stripped). */
  readonly body: string
}

/** Result of {@link ./index.ts#classifyDiff}. Categories are disjoint. */
export interface DiffClassification {
  /** Hunks that are NOT part of a recognized moved pair. Render as normal diff. */
  readonly logic: readonly DiffHunk[]
  /** Recognized moved-code pairs. Each input `-`/`+` hunk appears in at most one. */
  readonly moved: readonly MovedBlock[]
  /**
   * Mechanical-only hunks (pure reformat / whitespace). Currently always empty —
   * follow-up per ADR-0109 §결과. Field exists in contract so callers can branch
   * once the classifier is enabled without a future breaking change.
   */
  readonly mechanical: readonly DiffHunk[]
}

/** Tuning knobs. All defaults justified in ADR-0109 §결정. */
export interface ClassifyOptions {
  /**
   * Minimum number of NON-BLANK normalized lines in EACH side of a candidate
   * pair. Below this, the pair is rejected to avoid short-block false
   * positives (e.g. a 2-line import moved between files).
   * Default: 5.
   */
  readonly minLines?: number
  /**
   * Minimum Jaccard token similarity for a pair to qualify as "moved".
   * Default: 0.85.
   */
  readonly minSimilarity?: number
  /**
   * Maximum |removed| × |added| pair-product allowed. Above this we skip
   * detection (everything → logic) to bound O(N×M) cost on huge diffs.
   * Default: 10_000.
   */
  readonly maxPairs?: number
}
