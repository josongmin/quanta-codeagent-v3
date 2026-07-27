/** Raw-line-reader terminal RENDER + scroll-band machine, extracted from the
 *  `readLine` driver in `raw-line-reader.ts`.
 *
 *  These functions own the impure terminal writes (band growth, redraw, band
 *  release, final exit echo) but hold NO state of their own — they read the
 *  reader's mutable `State` + immutable layout constants through a
 *  `RenderContext` and write to the injected `stdout`. Factoring them out keeps
 *  the `readLine` driver a thin wiring shell over the keymap table; the byte
 *  stream each produces is identical to the original inline closures. */

import type { AtState } from "../at-autocomplete"
import {
  CR,
  CYAN,
  DIM,
  ERASE_LINE,
  fillBgRow,
  GRAY,
  MAX_VISIBLE_CANDIDATES,
  moveDown,
  moveRight,
  moveUp,
  RESET,
  stringColumns,
  stripAnsi,
} from "./ansi"
import { projectPasteDisplay } from "./paste-display"
import { atListRows as atListRowsFor, ghostSuffix, renderListRows } from "./render-rows"
import type { DescribeFn, State } from "./types"

/** The subset of `ReadLineOptions` the renderer reads. */
interface RenderOpts {
  readonly prompt: string
  readonly describe?: DescribeFn
}

/** Immutable-per-call context the render machine reads. `metaText` is a boxed
 *  mutable slot (the mode-cycle handler rewrites its `.value`); everything else
 *  is fixed at `readLine` construction. */
export interface RenderContext {
  readonly state: State
  readonly opts: RenderOpts
  readonly stdout: { write(chunk: string): unknown }
  readonly promptCols: number
  readonly META_ROWS: number
  readonly metaText: { value: string | undefined }
}

/** `@`-dropdown is OPEN iff active AND has ≥1 candidate. */
const atDropdownOpen = (at: AtState): boolean => at.active && at.candidates.length > 0

export const targetReserved = (ctx: RenderContext): number => {
  const { state, META_ROWS } = ctx
  // meta row (if any) + blank row + list rows (slash OR @-dropdown).
  const listRows = state.listOpen
    ? Math.min(state.candidates.length, MAX_VISIBLE_CANDIDATES) +
      (state.candidates.length > MAX_VISIBLE_CANDIDATES ? 1 : 0)
    : atDropdownOpen(state.at)
      ? atListRowsFor(state.at).length
      : 0
  const blankRow = listRows > 0 ? 1 : 0
  return META_ROWS + blankRow + listRows
}

export const growBandTo = (ctx: RenderContext, rows: number): void => {
  const { state, stdout } = ctx
  if (rows <= state.reserved) return
  const extra = rows - state.reserved
  // Move past the current band, emit `extra` newlines (this is where a one-time
  // scroll happens if the prompt is near the bottom), then walk back.
  let out = ""
  out += moveDown(state.reserved)
  out += "\n".repeat(extra)
  out += moveUp(state.reserved + extra)
  stdout.write(out)
  state.reserved = rows
}

export const redraw = (ctx: RenderContext): void => {
  const { state, opts, stdout, promptCols, META_ROWS, metaText } = ctx
  const target = targetReserved(ctx)
  growBandTo(ctx, Math.max(target, state.reserved))

  let out = ""
  // Slash palette and `@`-dropdown are mutually exclusive; the slash rows win.
  const listRows = state.listOpen
    ? renderListRows(state.listOpen, state.candidates, state.selectedIdx, opts.describe)
    : atDropdownOpen(state.at)
      ? atListRowsFor(state.at)
      : []
  for (let i = 0; i < state.reserved; i += 1) {
    out += moveDown(1) + CR + ERASE_LINE
    if (i === 0 && META_ROWS === 1) {
      out += fillBgRow(`  ${DIM}${metaText.value}${RESET}`)
      continue
    }
    const listOffset = META_ROWS === 1 ? 2 : 1
    if (i >= listOffset && i - listOffset < listRows.length) {
      out += listRows[i - listOffset] ?? ""
    }
  }
  out += moveUp(state.reserved)
  out += CR + ERASE_LINE
  if (state.searchMode) {
    const tag = `${GRAY}(reverse-i-search) '${state.searchQuery}':${RESET} `
    out += fillBgRow(`${tag}${state.searchMatch}`)
    const cursorCol = stringColumns(stripAnsi(tag)) + stringColumns(state.searchMatch)
    out += CR + moveRight(cursorCol)
    stdout.write(out)
    return
  }
  const displayPrompt = state.heredocOpen ? `${DIM}… ${RESET}` : `${CYAN}${opts.prompt}${RESET}`
  const echoBuf = projectPasteDisplay(state.buf, state.pasteSegments)
  out += fillBgRow(`${displayPrompt}${echoBuf}`)
  if (!state.listOpen && !state.heredocOpen && state.cursor === state.buf.length) {
    const ghost = ghostSuffix(state.buf, state.candidates)
    if (ghost !== "") {
      out += CR + ERASE_LINE
      out += fillBgRow(`${displayPrompt}${echoBuf}${DIM}${ghost}${RESET}`)
    }
  }
  const displayPromptCols = state.heredocOpen ? 2 : promptCols
  const cursorWidth =
    state.pasteSegments.length === 0
      ? stringColumns(state.buf.slice(0, state.cursor))
      : stringColumns(echoBuf)
  out += CR + moveRight(displayPromptCols + cursorWidth)
  stdout.write(out)
}

export const releaseBand = (ctx: RenderContext): void => {
  const { state, stdout } = ctx
  if (state.reserved === 0) return
  let out = ""
  for (let i = 0; i < state.reserved; i += 1) {
    out += moveDown(1) + CR + ERASE_LINE
  }
  out += moveUp(state.reserved)
  stdout.write(out)
  state.reserved = 0
}

export const finalRenderForExit = (ctx: RenderContext): void => {
  const { state, opts, stdout } = ctx
  releaseBand(ctx)
  // jun-6 — the final echo collapses paste blobs (`[Pasted Content N chars]`).
  const echoBuf = projectPasteDisplay(state.buf, state.pasteSegments)
  if (echoBuf.includes("\n")) {
    const lines = echoBuf.split("\n")
    const head = lines[0] ?? ""
    const tail = lines.slice(1)
    let echo = `${CR}${ERASE_LINE}${opts.prompt}${head}\n`
    for (const line of tail) echo += `  ${line}\n`
    stdout.write(echo)
    return
  }
  stdout.write(`${CR}${ERASE_LINE}${opts.prompt}${echoBuf}\n`)
}
