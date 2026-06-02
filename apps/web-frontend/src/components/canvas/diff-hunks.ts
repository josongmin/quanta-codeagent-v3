/**
 * ADR-0448 (RFC-10) — pure hunk grouping (no React, no WS, no diff math).
 *
 * RFC-06 ships `DiffLineData[]` as a FLAT list (inline-only). This module
 * groups that flat list into hunks: runs of changed lines (with `contextLines`
 * of surrounding unchanged context kept visible) interleaved with long
 * unchanged runs that become *collapsible* (`collapsed: true`).
 *
 * It re-runs NO diff math — it only re-segments the already-classified
 * `DiffLineData[]` the daemon produced (per RFC-10 §4.1.2). The `contextLines`
 * model is the validated `git diff` default (3), not an invented heuristic
 * ([[no-heuristics-only-validated]]). Deterministic: same input ⇒ same split.
 */

import type { DiffLineData } from "../../types/protocol"

export interface DiffHunk {
  /** The lines in this hunk, in original order. */
  readonly lines: readonly DiffLineData[]
  /** True ⇒ an all-unchanged run wide enough to fold (render collapsed). */
  readonly collapsed: boolean
}

const isChanged = (line: DiffLineData): boolean => line.type === "added" || line.type === "removed"

/**
 * Group flat diff lines into visible-change hunks + collapsible unchanged runs.
 *
 * Rules (deterministic):
 *  - A changed line and the `contextLines` unchanged lines on each side of it
 *    stay in a visible (`collapsed: false`) hunk.
 *  - An interior unchanged run longer than `2 * contextLines` has its inner
 *    excess (the part beyond the kept context on both sides) emitted as a
 *    single `collapsed: true` hunk.
 *  - All-unchanged input ⇒ one `collapsed: true` hunk (nothing to anchor on),
 *    UNLESS shorter than the fold threshold, in which case it stays visible.
 *  - Empty input ⇒ `[]` (never throws).
 *
 * @param lines        the flat, already-classified diff lines
 * @param contextLines unchanged lines kept around each change (git default 3)
 */
export const groupHunks = (
  lines: readonly DiffLineData[],
  contextLines = 3,
): readonly DiffHunk[] => {
  if (lines.length === 0) return []
  const ctx = Math.max(0, Math.trunc(contextLines))

  // Mark which lines must stay visible: every changed line, plus `ctx` lines on
  // each side. Anything not marked is foldable context.
  const visible = new Array<boolean>(lines.length).fill(false)
  let anyChange = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line !== undefined && isChanged(line)) {
      anyChange = true
      const lo = Math.max(0, i - ctx)
      const hi = Math.min(lines.length - 1, i + ctx)
      for (let j = lo; j <= hi; j++) visible[j] = true
    }
  }

  // No changes at all: a single collapsed hunk (the whole file is context).
  if (!anyChange) {
    return [{ lines, collapsed: true }]
  }

  // Walk the visibility mask into contiguous runs; visible runs are normal
  // hunks, hidden runs become collapsed hunks.
  const hunks: DiffHunk[] = []
  let runStart = 0
  for (let i = 1; i <= lines.length; i++) {
    const boundary = i === lines.length || visible[i] !== visible[i - 1]
    if (!boundary) continue
    const slice = lines.slice(runStart, i)
    const collapsed = visible[runStart] === false
    hunks.push({ lines: slice, collapsed })
    runStart = i
  }
  return hunks
}
