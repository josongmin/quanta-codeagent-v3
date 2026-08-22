/**
 * `@/tool/git/review-anchor-synth` — RFC-12 SURFACE B PRODUCER (Piece 1).
 *
 * The reviewer sub-agent reports each finding as `{ file, line, ... }` but never
 * emits the render-side `anchor`. This module SYNTHESIZES a validated
 * {@link ReviewCommentAnchor} from a finding's OWN already-parsed `file` + `line`
 * against the REAL `(before, after)` diff the reviewer saw — the same before/after
 * the daemon renders — so `reviewFindingsToAnchors` can project a live overlay.
 *
 * Honesty gate (NON-VACUOUS by construction): the synthesized anchor is
 * re-validated through the EXISTING `validateAnchoredFinding` (`review-anchor.ts`)
 * — a finding whose `line` lands OUTSIDE every new-side hunk of the diff (a loose
 * or fabricated line the reviewer never actually saw on the new side) is DROPPED,
 * not mis-anchored to a wrong row. Only findings that map to a real, current hunk
 * survive.
 *
 * Pure — no I/O. The before/after text is fetched by the caller (`review-diff.ts`)
 * via per-file git-show and handed in through {@link AnchorDiffContext}.
 */

import { splitHunks } from "@/runner/diff-ops"
import { sha256Hex } from "@/storage"
import type { AnchorDiffContext } from "./review-anchor"
import { validateAnchoredFinding } from "./review-anchor"
import type { ReviewCommentAnchor, ReviewFinding } from "./review-diff"

/**
 * Find the hunk whose NEW SIDE contains the 1-based new-file `line`, and return
 * its id — or `null` when no hunk produces that line (a pure-deletion region, a
 * context line, or an out-of-range line the reviewer reported loosely). The
 * new-side rows a hunk produces are `[newStart, newStart + addCount - 1]`
 * (see `DiffHunk` in `@/runner/diff-ops`); a hunk with `addCount === 0` produces
 * NO new-side line and can never own an overlay.
 */
const hunkIdForNewLine = (before: string, after: string, line: number): string | null => {
  for (const h of splitHunks(before, after)) {
    if (h.addCount === 0) continue
    if (line >= h.newStart && line < h.newStart + h.addCount) return h.id
  }
  return null
}

/**
 * Synthesize a full {@link ReviewCommentAnchor} for one finding from its parsed
 * `file` + `line` against the diff `ctx`. Returns `null` when the finding has no
 * `line`, targets a different path, or its `line` maps to no new-side hunk — the
 * three cases that must NOT overlay a diff row.
 */
const synthesizeAnchor = (
  finding: ReviewFinding,
  ctx: AnchorDiffContext,
): ReviewCommentAnchor | null => {
  if (finding.line === undefined) return null
  if (finding.file !== ctx.path) return null
  const hunkId = hunkIdForNewLine(ctx.before, ctx.after, finding.line)
  if (hunkId === null) return null
  return {
    path: finding.file,
    line: finding.line,
    hunkId,
    beforeHash: sha256Hex(ctx.before),
    afterHash: sha256Hex(ctx.after),
  }
}

/**
 * Synthesize + VALIDATE anchors for a file's findings against its `(before,
 * after)` diff. Returns the subset of findings that carry a REAL, ACTIONABLE
 * anchor (each finding cloned with its synthesized `anchor` set). Findings that
 * cannot be anchored are DROPPED from the result — they still reach the model via
 * the tool's structured payload, but they get no overlay row (they have no diff
 * line to land on). The synthesized anchor is re-checked through the EXISTING
 * `validateAnchoredFinding` so the render path and the apply-target path share one
 * honesty gate.
 */
export const synthesizeAnchoredFindings = (
  findings: readonly ReviewFinding[],
  ctx: AnchorDiffContext,
): ReviewFinding[] => {
  const out: ReviewFinding[] = []
  for (const finding of findings) {
    const anchor = synthesizeAnchor(finding, ctx)
    if (anchor === null) continue
    const anchored: ReviewFinding = { ...finding, anchor }
    // Belt-and-braces: re-validate through the canonical gate. A synthesized
    // anchor is actionable by construction (hash + hunk derived from THIS diff),
    // but routing it through `validateAnchoredFinding` means the render path can
    // never diverge from the apply-target honesty gate.
    if (validateAnchoredFinding(anchored, ctx).actionable) out.push(anchored)
  }
  return out
}
