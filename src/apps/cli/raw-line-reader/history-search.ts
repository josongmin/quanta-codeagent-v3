/** Raw-line-reader heredoc fence detection + history-recall / reverse-i-search
 *  helpers, extracted from `raw-line-reader.ts`. They operate on the reader's
 *  mutable `State` (so the `onKey` routing stays byte-for-byte equivalent) and
 *  take the reader-owned `refresh` / `redraw` callbacks where a repaint is due.
 *  All inert unless `opts.history` is wired (the reader's branches gate that). */

import type { State } from "./types"

/** The subset of `PromptHistory` these helpers read. */
interface HistoryPort {
  reset(): unknown
  search(query: string): string | undefined
}

/** Heredoc fence detector. A line is a fence iff it equals (after trim)
 *  the configured opener `"""` or backtick `'''`. Returns the fence
 *  string when matched, else `""`. */
const HEREDOC_FENCES = ['"""', "'''"]
export const detectFence = (line: string): string => {
  const trimmed = line.trim()
  for (const f of HEREDOC_FENCES) if (trimmed === f) return f
  return ""
}

/** Replace `buf` with a history-recall entry (or restore the saved draft
 *  on past-newest). Resets cursor and refreshes candidates so a slash-
 *  prefixed recalled entry re-opens the menu correctly. */
export const setBufFromHistory = (
  state: State,
  next: string | undefined,
  refreshCandidates: () => void,
): void => {
  if (next === undefined) {
    // past-newest ⇒ restore the draft the user was typing.
    state.buf = state.historyDraft ?? ""
    state.historyDraft = null
  } else {
    if (state.historyDraft === null) state.historyDraft = state.buf
    state.buf = next
  }
  state.cursor = state.buf.length
  refreshCandidates()
}

/** Reverse-i-search step: re-run the search with the current query and
 *  paint the match (or clear it on no-match). Cursor inside the history
 *  ring is owned by `history.search()` itself. */
export const stepSearch = (
  state: State,
  history: HistoryPort | undefined,
  redraw: () => void,
): void => {
  if (history === undefined) return
  if (state.searchQuery === "") {
    state.searchMatch = ""
    redraw()
    return
  }
  // Always restart the search from the newest entry so query edits do
  // not strand the cursor — `reset()` then `search(query)`.
  history.reset()
  state.searchMatch = history.search(state.searchQuery) ?? ""
  redraw()
}

export const commitSearch = (state: State, refreshCandidates: () => void): boolean => {
  if (!state.searchMode) return false
  const pick = state.searchMatch
  state.searchMode = false
  state.searchQuery = ""
  state.searchMatch = ""
  if (pick !== "") {
    state.buf = pick
    state.cursor = state.buf.length
    refreshCandidates()
  }
  return true
}

export const cancelSearch = (state: State): void => {
  state.searchMode = false
  state.searchQuery = ""
  state.searchMatch = ""
}
