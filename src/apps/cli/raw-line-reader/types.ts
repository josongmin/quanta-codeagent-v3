/** Raw-line-reader shared types + the longest-common-prefix utility, extracted
 *  from `raw-line-reader.ts`. `CandidateDescriptor`, `CompleterFn` and
 *  `DescribeFn` are part of the reader's public surface and are re-exported
 *  from the parent module so importers stay byte-compatible. `State` is the
 *  internal reader machine state; `longestCommonPrefix` is a pure helper. */

import type { AtState } from "../at-autocomplete"
import type { PasteSegment } from "./paste-display"

export interface CandidateDescriptor {
  readonly value: string
  readonly description?: string
}

export type CompleterFn = (line: string) => readonly string[]
export type DescribeFn = (candidate: string) => string | undefined

export interface State {
  buf: string
  cursor: number
  candidates: readonly string[]
  selectedIdx: number
  listOpen: boolean
  /** Number of rows currently reserved BELOW the prompt line. Grows
   *  monotonically per readLine call so subsequent redraws stay inside a
   *  scroll-stable band. */
  reserved: number
  /** History navigation: saved draft so `next()` past-newest restores what
   *  the user was typing before pressing `↑`. `null` ⇒ not navigating. */
  historyDraft: string | null
  /** Reverse-i-search mode: when active, keystrokes filter the search query
   *  instead of editing `buf`. The matched history entry is previewed in the
   *  prompt row; `Enter` commits it into `buf`, `Esc` cancels. */
  searchMode: boolean
  searchQuery: string
  searchMatch: string
  /** Heredoc multiline: when open, completed lines accumulate here. The
   *  active row is still `buf`; on fence-close they are joined with `\n`
   *  and resolved. */
  heredocOpen: boolean
  heredocFence: string
  heredocLines: string[]
  /** RFC-12 — `@`-mention dropdown sub-state. Dormant (`at.active=false`)
   *  unless `opts.atProvider` is injected AND the user typed a boundary `@`. */
  at: AtState
  /** jun-6 — recorded paste-burst segments. Empty unless `opts.pasteBurst` is
   *  injected AND a ≥minChars keypress arrived. Display-only: `buf` always holds
   *  the FULL text; these only collapse the ECHO. */
  pasteSegments: PasteSegment[]
  /** #10 — true between a `paste-start` and `paste-end` marker. While true,
   *  EVERY keypress is accumulated into `pasteText` (CR/LF normalized to `\n`)
   *  rather than routed to the submit / nav / completion handlers, so a
   *  multi-line paste never submits at its first newline. Inert (always false)
   *  unless `opts.bracketedPaste` is set AND the terminal sent a paste-start. */
  pasting: boolean
  /** Cursor index where the active paste began (where the accumulated text is
   *  spliced into `buf` on paste-end). */
  pasteAnchor: number
  /** Accumulated text of the active paste (line breaks normalized to `\n`). */
  pasteText: string
  /** `\r\n` collapse latch: a `\n` (`name:"enter"`) immediately after a `\r`
   *  (`name:"return"`) is the second half of a CRLF and is dropped so the
   *  buffer keeps a single `\n` per line break. */
  pasteLastCR: boolean
}

export const longestCommonPrefix = (candidates: readonly string[]): string => {
  if (candidates.length === 0) return ""
  let prefix = candidates[0] ?? ""
  for (let i = 1; i < candidates.length; i += 1) {
    const cur = candidates[i] ?? ""
    let j = 0
    while (j < prefix.length && j < cur.length && prefix[j] === cur[j]) j += 1
    prefix = prefix.slice(0, j)
    if (prefix === "") return ""
  }
  return prefix
}
