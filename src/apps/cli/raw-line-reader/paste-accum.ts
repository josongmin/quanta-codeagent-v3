/** #10 — bracketed-paste accumulation, extracted from `raw-line-reader.ts`.
 *  Bun's `node:readline` surfaces the DECSET 2004 markers as discrete
 *  `paste-start`/`paste-end` keypresses (probe 2026-06-11); we ALSO match the
 *  raw `sequence` as a fallback for runtimes that pass it through unnamed.
 *
 *  These operate on the reader's mutable `State` (so the closures in `readLine`
 *  stay byte-for-byte equivalent); `finishPaste` takes the `refresh` + `redraw`
 *  callbacks the reader owns. No terminal access of their own. */

import { ESC } from "./ansi"
import type { KeyEvent } from "./key-event"
import { pasteBurstPlaceholder } from "./paste-display"
import type { State } from "./types"

/** The subset of `ReadLineOptions` the paste-accumulator reads. */
interface PasteAccumOpts {
  readonly pasteBurst?: { readonly minChars: number }
  readonly history?: { reset(): unknown }
}

export const isPasteStart = (k: KeyEvent): boolean =>
  k.name === "paste-start" || k.sequence === `${ESC}200~`
export const isPasteEnd = (k: KeyEvent): boolean =>
  k.name === "paste-end" || k.sequence === `${ESC}201~`

export const beginPaste = (state: State): void => {
  state.pasting = true
  state.pasteAnchor = state.cursor
  state.pasteText = ""
  state.pasteLastCR = false
}

/** Fold one in-paste keypress into `pasteText`. CR (`name:"return"`) and LF
 *  (`name:"enter"`) both become a single `\n`; a `\n` directly after a `\r`
 *  is the trailing half of a CRLF and is dropped. Non-printable control keys
 *  (arrows etc.) inside a paste are ignored — a paste is data, not editing. */
export const accumulatePasteKey = (state: State, str: string | undefined, k: KeyEvent): void => {
  if (k.name === "return" || str === "\r") {
    state.pasteText += "\n"
    state.pasteLastCR = true
    return
  }
  if (k.name === "enter" || str === "\n") {
    if (state.pasteLastCR) {
      state.pasteLastCR = false
      return
    }
    state.pasteText += "\n"
    return
  }
  state.pasteLastCR = false
  if (typeof str === "string" && str.length >= 1) state.pasteText += str
}

/** Splice the accumulated paste into `buf` at its anchor in ONE mutation and
 *  redraw once. The echo collapses to a `[Pasted Content N chars]` placeholder
 *  when the paste is multi-line (a raw `\n` in `buf` would corrupt the single-
 *  row composer band) or when paste-burst is configured and the size crosses
 *  its threshold; a short single-line paste inserts raw (renders inline). The
 *  FULL text always stays in `buf` and submits verbatim on the next genuine
 *  Enter. */
export const finishPaste = (
  state: State,
  opts: PasteAccumOpts,
  refreshCandidates: () => void,
  redraw: () => void,
): void => {
  state.pasting = false
  const text = state.pasteText
  state.pasteText = ""
  state.pasteLastCR = false
  if (text.length > 0) {
    const anchor = Math.min(state.pasteAnchor, state.buf.length)
    state.buf = state.buf.slice(0, anchor) + text + state.buf.slice(anchor)
    state.cursor = anchor + text.length
    const count = [...text].length
    const collapse =
      text.includes("\n") || (opts.pasteBurst !== undefined && count >= opts.pasteBurst.minChars)
    if (collapse) state.pasteSegments.push({ text, placeholder: pasteBurstPlaceholder(count) })
    if (state.historyDraft !== null) {
      state.historyDraft = null
      opts.history?.reset()
    }
  }
  refreshCandidates()
  redraw()
}
