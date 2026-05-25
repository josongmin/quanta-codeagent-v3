/**
 * ADR-0207 — `Stage1Entry` shape.
 *
 * Per-thread Phase 1 distillation record, mirroring Codex
 * `stage1_outputs` column-for-column (camelCase translation only).
 * Closed-set: every field is `readonly`; the optional snapshot column
 * uses `?` (OMIT semantics) under `exactOptionalPropertyTypes: true`
 * — callers MUST NOT pass `undefined` literally.
 *
 * Note: this is the SIBLING shape to {@link Stage1Output} in
 * `src/memory/consolidate/types.ts`. The consolidate slice owns the
 * watermark/promotion surface (`upsert/fetchSince/countSince`); this
 * slice owns the usage/selection cache (`get/put/touch/markSelectedForPhase2/list/prune`).
 * They never import each other (see ADR-0207 §Decision §Slice boundary).
 */

export interface Stage1Entry {
  /** PRIMARY KEY — exactly one entry per thread. `put` of a duplicate
   *  `threadId` REPLACES the prior entry. */
  readonly threadId: string
  /** ms epoch — when the source session was last touched. Drives
   *  `markSelectedForPhase2` invalidation (Phase 2 ignores a row
   *  whose `sourceUpdatedAt` no longer matches the snapshot). */
  readonly sourceUpdatedAt: number
  /** Raw key facts / decisions / preferences / blockers extracted from
   *  this thread. Markdown bullets. */
  readonly rawMemory: string
  /** LLM-distilled summary, ~1-3 paragraphs. */
  readonly rolloutSummary: string
  /** ms epoch — when this Stage 1 record was generated. Used by
   *  `prune({olderThanMs})`. */
  readonly generatedAt: number
  /** Human-readable session slug — `${YYYYMMDD-HHMMSS}-${title}` form
   *  is Codex parity; any non-empty string accepted. */
  readonly rolloutSlug: string
  /** Cumulative usage count — `touch` bumps this. High counts are
   *  anchor rows; Phase 2 preserves them across rolling distill. */
  readonly usageCount: number
  /** ms epoch — last time `touch` was called (or `generatedAt` if
   *  never touched). LRU prune uses ascending order on this field. */
  readonly lastUsage: number
  /** Whether this row is queued for the NEXT Phase 2 run.
   *  `markSelectedForPhase2` sets `true`; `put` resets to `false`
   *  by default unless the caller passes `true` explicitly. */
  readonly selectedForPhase2: boolean
  /**
   * Snapshot of `sourceUpdatedAt` AT THE MOMENT of
   *  `markSelectedForPhase2`. Optional under
   *  `exactOptionalPropertyTypes`: present iff the entry has been
   *  marked at least once. Phase 2 compares this against the live
   *  `sourceUpdatedAt` and skips the row if they disagree (source
   *  thread mutated since selection → re-distill needed).
   *
   *  OMIT semantics: when absent, the property MUST NOT appear on the
   *  object literal (no `undefined` slot). See `markSelectedForPhase2`
   *  adapter impls for the conditional-spread pattern.
   */
  readonly selectedForPhase2SourceUpdatedAt?: number
}
