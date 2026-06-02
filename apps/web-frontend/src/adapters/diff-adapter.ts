/**
 * ADR-0440 — lossless diff adapter (frontend side).
 *
 * The daemon already converts the CLI `DiffOp[]` into render-side
 * `DiffLineData[]` (see `src/apps/web-daemon/canvas-emitter.ts#diffOpsToLines`)
 * and ships them in a `ToolDiffMessage`. This adapter does the remaining pure
 * form-conversions the components need — it NEVER re-runs diff math:
 *
 *   - `diffStatsFromMessage` — read `additions`/`deletions` straight off the
 *     message (the daemon counted them from the SAME ops). Provided as a named
 *     accessor so the host card never recomputes by scanning `lines`.
 *   - `diffStatsFromLines` — fallback that DERIVES counts by tallying line
 *     types (used only when a caller has lines but no counts — still pure
 *     tally, no diff math).
 *
 * Mirrors Cursor `DiffStats` props `{ additions, deletions }`.
 */

import type { DiffLineData, ToolDiffMessage } from "../types/protocol"

export interface DiffStatsProps {
  readonly additions: number
  readonly deletions: number
}

/** Read the daemon-computed counts straight off the message. No recompute. */
export const diffStatsFromMessage = (msg: ToolDiffMessage): DiffStatsProps => ({
  additions: msg.additions,
  deletions: msg.deletions,
})

/** Tally line types into counts. Pure — a tally over already-classified lines,
 *  NOT a diff. Used when counts are absent (e.g. a test fixture of raw lines). */
export const diffStatsFromLines = (lines: readonly DiffLineData[]): DiffStatsProps => {
  let additions = 0
  let deletions = 0
  for (const line of lines) {
    if (line.type === "added") additions += 1
    else if (line.type === "removed") deletions += 1
  }
  return { additions, deletions }
}
