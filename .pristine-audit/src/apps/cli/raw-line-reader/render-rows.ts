/** Raw-line-reader candidate-list / `@`-dropdown / ghost-text row rendering,
 *  extracted from `raw-line-reader.ts` as PURE functions (state in, styled
 *  rows out). No terminal writes, no mutation — the reader's `redraw` closure
 *  calls these and paints the returned rows. */

import type { AtCandidate, AtState } from "../at-autocomplete"
import { CYAN, GRAY, MAX_VISIBLE_CANDIDATES, RESET, REVERSE, stringColumns } from "./ansi"
import type { DescribeFn } from "./types"

export const ghostSuffix = (buf: string, candidates: readonly string[]): string => {
  if (candidates.length === 0) return ""
  const top = candidates[0] ?? ""
  if (!top.startsWith(buf)) return ""
  return top.slice(buf.length)
}

/** Render the slash-command candidate list: a two-column `name … desc` list,
 *  the selected row in reverse-cyan, capped at `MAX_VISIBLE_CANDIDATES` with a
 *  "+N more" overflow marker. Pure; returns `[]` when the list is closed. */
export const renderListRows = (
  listOpen: boolean,
  candidates: readonly string[],
  selectedIdx: number,
  describe: DescribeFn | undefined,
): string[] => {
  if (!listOpen || candidates.length === 0) return []
  const visible = candidates.slice(0, MAX_VISIBLE_CANDIDATES)
  const extra = candidates.length - visible.length
  const nameW = Math.max(...visible.map((c) => stringColumns(c)))
  const rows = visible.map((c, i) => {
    const namePadded = c + " ".repeat(Math.max(0, nameW - stringColumns(c)))
    const desc = describe?.(c) ?? ""
    const sel = i === selectedIdx
    const nameStyled = sel
      ? `${REVERSE}${CYAN}${namePadded}${RESET}`
      : `${CYAN}${namePadded}${RESET}`
    const descStyled = desc !== "" ? `  ${GRAY}${desc}${RESET}` : ""
    return `${nameStyled}${descStyled}`
  })
  if (extra > 0) rows.push(`${GRAY}  … +${extra} more${RESET}`)
  return rows
}

/** RFC-12 §4.4 — render the `@`-dropdown as kind-grouped rows: a dim
 *  kind-section header followed by indented `label … detail` rows, the
 *  highlighted row in reverse-cyan. Reuses `stringColumns` for CJK-safe
 *  alignment. Capped at `MAX_VISIBLE_CANDIDATES` (headers excluded from
 *  the cap so a group is never orphaned); overflow shows "+N more". */
export const atListRows = (at: AtState): string[] => {
  const cands = at.candidates
  if (cands.length === 0) return []
  // Sliding window: show MAX_VISIBLE_CANDIDATES rows that always contain the
  // selection. `start` clamps so the window stays in-bounds; entries above
  // / below it are summarised with "+N" markers so nothing is silently
  // hidden (and, with full-list nav, everything stays reachable).
  const total = cands.length
  const win = MAX_VISIBLE_CANDIDATES
  const sel = at.selectedIdx
  let start = 0
  if (total > win) {
    start = Math.max(0, Math.min(sel - Math.floor(win / 2), total - win))
    if (sel < 0) start = 0
  }
  const visible = cands.slice(start, start + win)
  const above = start
  const below = total - (start + visible.length)
  const labelW = Math.max(1, ...visible.map((c) => stringColumns(c.label)))
  const rows: string[] = []
  if (above > 0) rows.push(`${GRAY}  … +${above} above${RESET}`)
  let lastKind: AtCandidate["kind"] | null = null
  visible.forEach((c, i) => {
    if (c.kind !== lastKind) {
      rows.push(`${GRAY}${c.kind}${RESET}`)
      lastKind = c.kind
    }
    const labelPadded = c.label + " ".repeat(Math.max(0, labelW - stringColumns(c.label)))
    const isSel = start + i === sel
    const labelStyled = isSel
      ? `  ${REVERSE}${CYAN}${labelPadded}${RESET}`
      : `  ${CYAN}${labelPadded}${RESET}`
    const detail = c.detail ?? ""
    const detailStyled = detail !== "" ? `  ${GRAY}${detail}${RESET}` : ""
    rows.push(`${labelStyled}${detailStyled}`)
  })
  if (below > 0) rows.push(`${GRAY}  … +${below} more${RESET}`)
  return rows
}
