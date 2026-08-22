/**
 * `@/tool/git/review-anchor` — RFC06-4 (B5): validate an inline review comment's
 * `anchor` against the REAL diff the reviewer saw.
 *
 * This is the anchored-comment carrier's honesty gate. It consumes the EXISTING
 * `ReviewFinding` (with RFC09-2's verdict/category/shortSummary) — it does NOT
 * define a second finding schema. A finding whose anchor references a `hunkId`
 * absent from `splitHunks(before, after)`, or whose `before`/`after` hashes do
 * not match the diff, is reported `actionable:false` (honest anchoring, mirror
 * of the hunk-apply staleness discipline). A finding with NO anchor passes
 * through unchanged and actionable (byte-identical to the pre-B5 blob shape).
 *
 * Pure — no I/O. The apply/undo receipt (`@/runner/hunk-mutation-journal`) is a
 * separate concern; this module only decides whether a comment is anchored to a
 * real, current hunk.
 */

import { splitHunks } from "@/runner/diff-ops"
import { sha256Hex } from "@/storage"
import type { ReviewFinding } from "./review-diff"

/** The diff a finding is validated against — the SAME `(before, after)` the
 *  reviewer's hunk ids were computed on. */
export interface AnchorDiffContext {
  readonly path: string
  readonly before: string
  readonly after: string
}

export type AnchoredFindingResult = {
  readonly finding: ReviewFinding
  /** True ⇒ the anchor (if any) is bound to a real, current hunk; the comment
   *  is a live per-hunk target. False ⇒ the anchor is stale/dangling and must
   *  NOT be treated as a hunk-apply target. */
  readonly actionable: boolean
  /** Categorical reason when `actionable:false`. Absent when actionable. */
  readonly reason?: string
}

/**
 * Validate one finding's anchor against the diff. No anchor ⇒ actionable
 * (unchanged). An anchor is actionable only when: same path, matching
 * before/after hashes (the reviewer saw THIS diff), and a `hunkId` that exists
 * in `splitHunks(before, after)`.
 */
export const validateAnchoredFinding = (
  finding: ReviewFinding,
  ctx: AnchorDiffContext,
): AnchoredFindingResult => {
  const anchor = finding.anchor
  if (anchor === undefined) return { finding, actionable: true }

  if (anchor.path !== ctx.path) {
    return { finding, actionable: false, reason: `anchor path '${anchor.path}' != diff path` }
  }
  // Hash gate FIRST: if the reviewer's diff snapshot differs, the hunk ids are
  // meaningless (they'd be computed on a different document).
  if (anchor.beforeHash !== sha256Hex(ctx.before) || anchor.afterHash !== sha256Hex(ctx.after)) {
    return { finding, actionable: false, reason: "anchor hash != current diff (stale snapshot)" }
  }
  const ids = splitHunks(ctx.before, ctx.after).map((h) => h.id)
  if (!ids.includes(anchor.hunkId)) {
    return { finding, actionable: false, reason: `anchor hunk '${anchor.hunkId}' not in diff` }
  }
  return { finding, actionable: true }
}

/** Validate every finding of a report against its diff. Convenience batch form;
 *  each finding is independently classified. */
export const validateAnchoredFindings = (
  findings: readonly ReviewFinding[],
  ctx: AnchorDiffContext,
): AnchoredFindingResult[] => findings.map((f) => validateAnchoredFinding(f, ctx))
