/** Bun-compatible line reader with Codex-style input box + below-prompt
 *  slash command palette.
 *
 *  Bun's `node:readline` polyfill (probe-verified 2026-05) does NOT invoke
 *  the `completer` option, so this module reads keys at the raw-mode
 *  `keypress` event level and renders the completion UX itself.
 *
 *  Layout (matches the Codex CLI reference):
 *
 *      › {buf}{ghost}                                           ◀ input row
 *        {meta}                                                 ◀ meta row
 *
 *      /name1      description for /name1                       ◀ candidate rows
 *      /name2      description for /name2                          (cyan name + dim desc)
 *      …
 *
 *  - The composer rows render on the terminal's default background — the
 *    earlier dark-band (xterm color 236) read as a solid black bar under
 *    dark themes, which several users called out as visually heavy.
 *  - The candidate list appears below the prompt rows, in a separate region.
 *    It's a plain two-column list (no border) with the command name in
 *    cyan and the description in dim gray, column-aligned to the widest
 *    visible name.
 *  - The list auto-opens as soon as the buffer starts with `/` and at
 *    least one candidate matches. Typing filters it in place; `↑`/`↓`
 *    navigate; `Tab`/`Enter` commit; `Esc` collapses it.
 *  - Ghost-text inline completion is still painted on the prompt row
 *    when the list is closed (a single match's tail in dim).
 *
 *  Scroll-stability invariant: every redraw paints inside the reserved
 *  band that the last expansion claimed; the band only ever grows (with
 *  a single terminal-scroll moment when it does), never shrinks
 *  mid-read. On read exit the band is fully erased and the prompt
 *  line is echoed normally so subsequent stdout starts on a fresh row.
 */

import * as readline from "node:readline"
import {
  type AtCandidate,
  type AtCandidateProvider,
  type AtState,
  acceptSelected,
  atQuery,
  classifyBackspace,
  classifyChar,
  createAtState,
  dismiss as dismissAt,
  selectNext,
  selectPrev,
} from "./at-autocomplete"
import type { PromptHistory } from "./prompt-history"

export interface CandidateDescriptor {
  readonly value: string
  readonly description?: string
}

export type CompleterFn = (line: string) => readonly string[]
export type DescribeFn = (candidate: string) => string | undefined

export interface ReadLineOptions {
  readonly prompt: string
  readonly completer?: CompleterFn
  /** Optional description resolver — passed each candidate string in the
   *  filtered list. Returning a string shows it as the dim right-column
   *  hint; returning `undefined` leaves the row name-only. */
  readonly describe?: DescribeFn
  /** Optional meta line shown directly under the input prompt. Typical
   *  content: `provider · model · cwd`. Rendered dim on default background. */
  readonly meta?: string
  readonly signal?: AbortSignal
  /** Optional bash-style prompt history. When provided:
   *    - `↑`/`↓` navigate older/newer entries when the completion menu is
   *      closed (otherwise they still navigate the menu, byte-identical).
   *    - `Ctrl+R` enters reverse-i-search mode.
   *    - `Enter` pushes the submitted line back into history.
   *  Absent ⇒ all keypress paths byte-identical to the no-history build. */
  readonly history?: PromptHistory
  /** Optional heredoc multiline mode. When enabled (`true`), a leading
   *  `"""` (triple-quote, triple-backtick also accepted) on its own line
   *  opens a continuation prompt; a single line containing only the same
   *  fence closes it and submits the joined body (`\n`-separated, fence
   *  rows excluded). Absent / `false` ⇒ byte-identical, no fence detection. */
  readonly multiline?: boolean
  /** RFC-12 / ADR-0439 — optional `@`-mention autocomplete provider. When
   *  injected, typing `@` at a valid left-boundary opens a kind-grouped
   *  candidate dropdown (file / symbol / skill / plugin / app); `↑`/`↓`
   *  select, `Tab`/`Enter` accept (splice the mention token), `Esc`
   *  dismiss. Absent ⇒ `@` is an ordinary input char and EVERY keypress
   *  path is byte-identical to the no-provider build. */
  readonly atProvider?: AtCandidateProvider
  /** RFC-08 / ADR-0443 — `shift+tab` mode-cycle hook. A NON-submit key: when
   *  present, `shift+tab` (a.k.a. backtab / CSI Z) invokes this callback, which
   *  advances the host's turn-boundary mode store and returns the new `meta`
   *  line (pill + desc) to repaint under the prompt. The input buffer is NEVER
   *  touched and the line is NOT submitted. Absent ⇒ `shift+tab` is fully
   *  ignored and every keypress path is byte-identical to the no-hook build. */
  readonly onCycleMode?: () => { meta?: string } | undefined
}

export class AbortError extends Error {
  constructor() {
    super("aborted")
    this.name = "AbortError"
  }
}

interface KeyEvent {
  readonly name?: string
  readonly ctrl?: boolean
  /** RFC-08 — node `readline.emitKeypressEvents` already populates `key.shift`;
   *  we widen the interface so the shift+tab (mode-cycle) guard can read it. */
  readonly shift?: boolean
  readonly sequence?: string
}

const ESC = "\x1b["
const ERASE_LINE = `${ESC}2K`
const ERASE_LINE_RIGHT = `${ESC}0K`
const CR = "\r"
const moveUp = (n: number): string => (n > 0 ? `${ESC}${n}A` : "")
const moveDown = (n: number): string => (n > 0 ? `${ESC}${n}B` : "")
const moveRight = (n: number): string => (n > 0 ? `${ESC}${n}C` : "")
const DIM = `${ESC}2m`
const RESET = `${ESC}0m`
const CYAN = `${ESC}36m`
const GRAY = `${ESC}90m`
const REVERSE = `${ESC}7m`

const ANSI_RE = /\x1b\[[0-9;]*m/g
const stripAnsi = (s: string): string => s.replace(ANSI_RE, "")

const charColumns = (ch: string): number => {
  const code = ch.codePointAt(0)
  if (code === undefined) return 1
  if (code < 0x80) return 1
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  ) {
    return 2
  }
  return 1
}

const stringColumns = (s: string): number => {
  let cols = 0
  for (const ch of s) cols += charColumns(ch)
  return cols
}

const MAX_VISIBLE_CANDIDATES = 8

/** Render a composer row. Previously this wrapped the content in a
 *  full-width dark-gray (xterm 236) background band so the prompt looked
 *  like a Codex-style "input box"; on dark terminal themes that band read
 *  as a solid black bar, so it now passes content through unchanged.
 *  The caller already emits `CR + ERASE_LINE` before each paint, so no
 *  width-padding is needed to overwrite stale content. */
const fillBgRow = (content: string): string => content

interface State {
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
}

const ghostSuffix = (buf: string, candidates: readonly string[]): string => {
  if (candidates.length === 0) return ""
  const top = candidates[0] ?? ""
  if (!top.startsWith(buf)) return ""
  return top.slice(buf.length)
}

/** Narrow stdin shape `readLine` actually uses. Lets tests inject a fake
 *  keypress source without a real TTY (RFC §7). NOT part of the public
 *  contract — production always passes `process.stdin`. */
interface ReaderStdin {
  on(event: "keypress", listener: KeypressListener): unknown
  removeListener(event: "keypress", listener: KeypressListener): unknown
  resume(): unknown
  pause(): unknown
  readonly isTTY?: boolean
  readonly isRaw?: boolean
  setRawMode?(mode: boolean): unknown
}
type KeypressListener = (str: string | undefined, key: KeyEvent | undefined) => void
interface ReaderStdout {
  write(chunk: string): unknown
}
/** Test-only I/O override. Production callers omit this entirely. */
export interface ReadLineTestIO {
  readonly stdin: ReaderStdin
  readonly stdout: ReaderStdout
  /** Skip `emitKeypressEvents` (the fake stdin emits `keypress` directly). */
  readonly skipKeypressSetup?: boolean
}

export const readLine = (opts: ReadLineOptions, testIO?: ReadLineTestIO): Promise<string> => {
  return new Promise<string>((resolve, reject) => {
    const stdin: ReaderStdin = testIO?.stdin ?? process.stdin
    const stdout: ReaderStdout = testIO?.stdout ?? process.stderr
    const promptCols = stringColumns(stripAnsi(opts.prompt))
    // RFC-08 — `metaText` is a MUTABLE copy of `opts.meta` so the shift+tab
    // mode-cycle hook can repaint the pill line in place. `META_ROWS` is fixed
    // at construction from the INITIAL meta: when a meta line is present (the
    // production path always passes `provider · model · cwd`), the row is
    // reserved once and the cycle only swaps its CONTENT — the reserved row
    // count never changes, so the band geometry stays stable. When no meta was
    // supplied, the cycle hook leaves the layout untouched (no row to paint).
    let metaText = opts.meta
    const META_ROWS = metaText !== undefined && metaText !== "" ? 1 : 0
    const state: State = {
      buf: "",
      cursor: 0,
      candidates: [],
      selectedIdx: -1,
      listOpen: false,
      reserved: 0,
      historyDraft: null,
      searchMode: false,
      searchQuery: "",
      searchMatch: "",
      heredocOpen: false,
      heredocFence: "",
      heredocLines: [],
      at: createAtState(),
    }
    // Reset the history cursor at the start of every readLine so `↑` always
    // pulls the freshest entry first. Default-OFF when `opts.history` absent.
    opts.history?.reset()
    let settled = false

    if (testIO?.skipKeypressSetup !== true) {
      readline.emitKeypressEvents(stdin as unknown as NodeJS.ReadStream)
    }
    const wasRaw = stdin.isTTY === true ? (stdin.isRaw ?? false) : false
    if (stdin.isTTY === true) stdin.setRawMode?.(true)
    stdin.resume()

    const refreshCandidates = (): void => {
      if (opts.completer === undefined) {
        state.candidates = []
        return
      }
      state.candidates = state.buf.startsWith("/") ? opts.completer(state.buf) : []
      // Auto-open the list whenever there's at least one match for a
      // slash-prefix buffer — Codex parity. The user never has to press
      // anything special to see the candidates.
      state.listOpen = state.candidates.length > 0
      if (state.listOpen && state.selectedIdx < 0) state.selectedIdx = 0
      if (!state.listOpen) state.selectedIdx = -1
      if (state.selectedIdx >= state.candidates.length) {
        state.selectedIdx = state.candidates.length - 1
      }
    }

    /** RFC-12 — `@`-dropdown is OPEN iff the sub-machine is active AND has at
     *  least one candidate. (`active` with zero candidates keeps the machine
     *  alive for re-query but reserves no rows — RFC §6 "no candidates".) */
    const atDropdownOpen = (): boolean => state.at.active && state.at.candidates.length > 0

    const targetReserved = (): number => {
      // meta row (if any) + blank row + list rows (slash OR @-dropdown).
      // The two completion modes are mutually exclusive: `@`-mode only opens
      // when `buf` does NOT start with `/`, so `state.listOpen` is false.
      const listRows = state.listOpen
        ? Math.min(state.candidates.length, MAX_VISIBLE_CANDIDATES) +
          (state.candidates.length > MAX_VISIBLE_CANDIDATES ? 1 : 0)
        : atDropdownOpen()
          ? atListRows().length
          : 0
      const blankRow = listRows > 0 ? 1 : 0
      return META_ROWS + blankRow + listRows
    }

    const growBandTo = (rows: number): void => {
      if (rows <= state.reserved) return
      const extra = rows - state.reserved
      // Move past the current band, emit `extra` newlines (this is where
      // a one-time scroll happens if the prompt is near the bottom), then
      // walk back to the prompt line.
      let out = ""
      out += moveDown(state.reserved)
      out += "\n".repeat(extra)
      out += moveUp(state.reserved + extra)
      stdout.write(out)
      state.reserved = rows
    }

    const renderListRows = (): string[] => {
      if (!state.listOpen || state.candidates.length === 0) return []
      const visible = state.candidates.slice(0, MAX_VISIBLE_CANDIDATES)
      const extra = state.candidates.length - visible.length
      const nameW = Math.max(...visible.map((c) => stringColumns(c)))
      const rows = visible.map((c, i) => {
        const namePadded = c + " ".repeat(Math.max(0, nameW - stringColumns(c)))
        const desc = opts.describe?.(c) ?? ""
        const sel = i === state.selectedIdx
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
    const atListRows = (): string[] => {
      const cands = state.at.candidates
      if (cands.length === 0) return []
      const visible = cands.slice(0, MAX_VISIBLE_CANDIDATES)
      const extra = cands.length - visible.length
      const labelW = Math.max(1, ...visible.map((c) => stringColumns(c.label)))
      const rows: string[] = []
      let lastKind: AtCandidate["kind"] | null = null
      visible.forEach((c, i) => {
        if (c.kind !== lastKind) {
          rows.push(`${GRAY}${c.kind}${RESET}`)
          lastKind = c.kind
        }
        const labelPadded = c.label + " ".repeat(Math.max(0, labelW - stringColumns(c.label)))
        const sel = i === state.at.selectedIdx
        const labelStyled = sel
          ? `  ${REVERSE}${CYAN}${labelPadded}${RESET}`
          : `  ${CYAN}${labelPadded}${RESET}`
        const detail = c.detail ?? ""
        const detailStyled = detail !== "" ? `  ${GRAY}${detail}${RESET}` : ""
        rows.push(`${labelStyled}${detailStyled}`)
      })
      if (extra > 0) rows.push(`${GRAY}  … +${extra} more${RESET}`)
      return rows
    }

    const redraw = (): void => {
      const target = targetReserved()
      growBandTo(Math.max(target, state.reserved))

      let out = ""
      // Cursor is at prompt line, buf cursor col. Walk down through the
      // band, painting each row (or erasing it). Use moveDown — it does
      // NOT scroll the terminal even at the bottom of the screen, so the
      // band is stable once reserved.
      // Slash palette and `@`-dropdown are mutually exclusive; the slash
      // rows win if (somehow) both were open.
      const listRows = state.listOpen ? renderListRows() : atDropdownOpen() ? atListRows() : []
      for (let i = 0; i < state.reserved; i += 1) {
        out += moveDown(1) + CR + ERASE_LINE
        if (i === 0 && META_ROWS === 1) {
          out += fillBgRow(`  ${DIM}${metaText}${RESET}`)
          continue
        }
        const listOffset = META_ROWS === 1 ? 2 : 1
        if (i >= listOffset && i - listOffset < listRows.length) {
          out += listRows[i - listOffset] ?? ""
        }
        // Rows that are within `reserved` but past the actual content
        // remain blank (we already wrote ERASE_LINE above).
      }
      // Walk back up to the prompt line.
      out += moveUp(state.reserved)
      // Repaint the prompt line.
      out += CR + ERASE_LINE
      if (state.searchMode) {
        // Reverse-i-search prompt: `(reverse-i-search) 'query': match`
        const tag = `${GRAY}(reverse-i-search) '${state.searchQuery}':${RESET} `
        out += fillBgRow(`${tag}${state.searchMatch}`)
        // Cursor after the query (inside the parens), not after the match —
        // matches the readline UX so backspace edits the query.
        const cursorCol = stringColumns(stripAnsi(tag)) + stringColumns(state.searchMatch)
        out += CR + moveRight(cursorCol)
        stdout.write(out)
        return
      }
      // Heredoc continuation: dim "… " indicator in the gutter to signal the
      // user is composing a multiline body.
      const displayPrompt = state.heredocOpen ? `${DIM}… ${RESET}` : `${CYAN}${opts.prompt}${RESET}`
      out += fillBgRow(`${displayPrompt}${state.buf}`)
      // Ghost text (only when list is closed AND cursor at end AND not in heredoc).
      if (!state.listOpen && !state.heredocOpen && state.cursor === state.buf.length) {
        const ghost = ghostSuffix(state.buf, state.candidates)
        if (ghost !== "") {
          // Repaint with ghost embedded inside the BG row.
          out += CR + ERASE_LINE
          out += fillBgRow(`${displayPrompt}${state.buf}${DIM}${ghost}${RESET}`)
        }
      }
      // Cursor back to prompt line, buf cursor col.
      const displayPromptCols = state.heredocOpen ? 2 : promptCols
      out += CR + moveRight(displayPromptCols + stringColumns(state.buf.slice(0, state.cursor)))
      stdout.write(out)
    }

    const releaseBand = (): void => {
      if (state.reserved === 0) return
      // Walk through the reserved band erasing every row, then come back
      // to the prompt line so the final echo + newline lands cleanly.
      let out = ""
      for (let i = 0; i < state.reserved; i += 1) {
        out += moveDown(1) + CR + ERASE_LINE
      }
      out += moveUp(state.reserved)
      stdout.write(out)
      state.reserved = 0
    }

    const cleanup = (): void => {
      stdin.removeListener("keypress", onKey)
      if (signalListener !== null) opts.signal?.removeEventListener("abort", signalListener)
      if (stdin.isTTY === true) stdin.setRawMode?.(wasRaw)
      stdin.pause()
    }

    const finalRenderForExit = (): void => {
      releaseBand()
      // Cursor is on the prompt line at the buffer cursor column. Wipe the
      // BG-styled prompt and echo it as plain text so subsequent stdout
      // doesn't bleed into the composer's background colour.
      // For a multiline body (heredoc submit) we echo line-by-line with the
      // continuation indicator on every subsequent row so the transcript
      // visually matches what the user typed.
      if (state.buf.includes("\n")) {
        const lines = state.buf.split("\n")
        const head = lines[0] ?? ""
        const tail = lines.slice(1)
        let echo = `${CR}${ERASE_LINE}${opts.prompt}${head}\n`
        for (const line of tail) echo += `  ${line}\n`
        stdout.write(echo)
        return
      }
      stdout.write(CR + ERASE_LINE + opts.prompt + state.buf + "\n")
    }

    const settleResolve = (value: string): void => {
      if (settled) return
      settled = true
      finalRenderForExit()
      cleanup()
      resolve(value)
    }

    const settleReject = (err: Error): void => {
      if (settled) return
      settled = true
      finalRenderForExit()
      cleanup()
      reject(err)
    }

    const signalListener: (() => void) | null = opts.signal
      ? () => settleReject(new AbortError())
      : null
    if (opts.signal && signalListener !== null) {
      if (opts.signal.aborted) {
        queueMicrotask(() => settleReject(new AbortError()))
      } else {
        opts.signal.addEventListener("abort", signalListener, { once: true })
      }
    }

    const acceptGhost = (): boolean => {
      const ghost = ghostSuffix(state.buf, state.candidates)
      if (ghost === "") return false
      state.buf += ghost
      state.cursor = state.buf.length
      refreshCandidates()
      return true
    }

    const commitSelected = (): boolean => {
      if (!state.listOpen || state.selectedIdx < 0) return false
      const pick = state.candidates[state.selectedIdx] ?? ""
      if (pick === "") return false
      state.buf = pick
      state.cursor = state.buf.length
      refreshCandidates()
      return true
    }

    // ── RFC-12 / ADR-0439 — `@`-mention autocomplete dropdown ───────────────
    // The keypress machine lives in the pure `at-autocomplete/state-machine`;
    // these closures own the impure parts (async `list()` + redraw + buffer
    // splice). All inert when `opts.atProvider` is undefined (default-OFF).

    /** Re-query the provider for the current `@`-query and reflect the result.
     *  Race-safe via `at.queryEpoch`: a stale `list()` (a later keystroke bumped
     *  the epoch) is discarded. NO-THROW: a rejected/thrown provider ⇒ empty. */
    const runAtList = async (): Promise<void> => {
      if (opts.atProvider === undefined || !state.at.active) return
      const query = atQuery(state.at, state.buf, state.cursor)
      state.at.queryEpoch += 1
      const myEpoch = state.at.queryEpoch
      let cands: readonly AtCandidate[]
      try {
        cands = await opts.atProvider.list(query, opts.signal)
      } catch {
        cands = []
      }
      if (settled) return
      if (myEpoch !== state.at.queryEpoch) return // stale: a newer query superseded
      if (!state.at.active) return // dismissed while awaiting
      state.at.candidates = cands
      state.at.selectedIdx = cands.length > 0 ? 0 : -1
      // `runAtList` is an async fn dispatched fire-and-forget (`void runAtList()`),
      // so a throw from `redraw` (a closed FD / write EPIPE mid-stream) would
      // surface as an UNHANDLED rejection. State is already consistent here, so
      // swallow a terminal-write failure — the next keystroke redraws.
      try {
        redraw()
      } catch {
        /* terminal write failed; state is consistent, next keystroke redraws */
      }
    }

    /** Open the dropdown at `triggerPos` (the index of the just-typed `@`) and
     *  kick off the initial empty-query list. */
    const openAtDropdown = (triggerPos: number): void => {
      state.at.active = true
      state.at.triggerPos = triggerPos
      state.at.candidates = []
      state.at.selectedIdx = -1
      void runAtList()
    }

    /** Accept the highlighted `@`-candidate: splice its `insertText` over
     *  `[triggerPos, cursor)` and close the dropdown. Returns false when there
     *  is no valid selection (caller falls through). */
    const commitAtSelected = (): boolean => {
      const edit = acceptSelected(state.at, state.buf, state.cursor)
      if (edit === null) return false
      state.buf = edit.nextBuf
      state.cursor = edit.nextCursor
      dismissAt(state.at)
      refreshCandidates()
      return true
    }

    /** Heredoc fence detector. A line is a fence iff it equals (after trim)
     *  the configured opener `"""` or backtick `'''`. Returns the fence
     *  string when matched, else `""`. */
    const HEREDOC_FENCES = ['"""', "'''"]
    const detectFence = (line: string): string => {
      const trimmed = line.trim()
      for (const f of HEREDOC_FENCES) if (trimmed === f) return f
      return ""
    }

    /** Replace `buf` with a history-recall entry (or restore the saved draft
     *  on past-newest). Resets cursor and refreshes candidates so a slash-
     *  prefixed recalled entry re-opens the menu correctly. */
    const setBufFromHistory = (next: string | undefined): void => {
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
     *  ring is owned by `opts.history.search()` itself. */
    const stepSearch = (): void => {
      if (opts.history === undefined) return
      if (state.searchQuery === "") {
        state.searchMatch = ""
        redraw()
        return
      }
      // Always restart the search from the newest entry so query edits do
      // not strand the cursor — `reset()` then `search(query)`.
      opts.history.reset()
      state.searchMatch = opts.history.search(state.searchQuery) ?? ""
      redraw()
    }

    const commitSearch = (): boolean => {
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

    const cancelSearch = (): void => {
      state.searchMode = false
      state.searchQuery = ""
      state.searchMatch = ""
    }

    const onKey = (str: string | undefined, key: KeyEvent | undefined): void => {
      if (settled) return
      const k = key ?? {}

      if (k.ctrl === true && k.name === "c") {
        settleReject(new AbortError())
        return
      }

      // RFC-08 — shift+tab (a.k.a. backtab / CSI Z) cycles the permission/agent
      // mode. A NON-submit key: it advances the host's turn-boundary store and
      // repaints the pill meta line, leaving the input buffer + cursor intact.
      // Disjoint from plain Tab (which has `shift` falsy) so completion / the
      // @-autocomplete Tab-accept are never reached by this guard. Absent hook
      // (default-OFF) ⇒ falls through → byte-identical to the no-hook build.
      const isBackTab = (k.name === "tab" && k.shift === true) || k.sequence === `${ESC}Z`
      if (isBackTab && opts.onCycleMode !== undefined) {
        const res = opts.onCycleMode()
        if (res && typeof res.meta === "string") metaText = res.meta
        redraw()
        return
      }

      // Reverse-i-search has the highest priority (consumes most keys until
      // resolved or cancelled). Activated by Ctrl+R; deactivated by Enter
      // (commit), Esc (cancel), or another Ctrl+R (step to next-older match).
      if (state.searchMode) {
        if (k.name === "return") {
          commitSearch()
          settleResolve(state.buf)
          return
        }
        if (k.name === "escape" || (k.ctrl === true && k.name === "g")) {
          cancelSearch()
          redraw()
          return
        }
        if (k.ctrl === true && k.name === "r") {
          // step backward in the history for the same query
          state.searchMatch = opts.history?.search(state.searchQuery) ?? state.searchMatch
          redraw()
          return
        }
        if (k.name === "backspace") {
          state.searchQuery = state.searchQuery.slice(0, -1)
          stepSearch()
          return
        }
        if (typeof str === "string" && str.length === 1 && str >= " ") {
          state.searchQuery += str
          stepSearch()
          return
        }
        // Ignore other keys inside search mode (no edit, no nav).
        return
      }

      if (k.ctrl === true && k.name === "r" && opts.history !== undefined) {
        state.searchMode = true
        state.searchQuery = ""
        state.searchMatch = ""
        opts.history.reset()
        redraw()
        return
      }

      // RFC-12 — `@`-dropdown key routing (priority below search/Ctrl+R, above
      // the slash/history nav). Only entered when the dropdown is active, which
      // requires `opts.atProvider` (default-OFF ⇒ this whole block is skipped).
      if (state.at.active) {
        const visible = Math.min(state.at.candidates.length, MAX_VISIBLE_CANDIDATES)
        if (k.name === "escape") {
          dismissAt(state.at)
          redraw()
          return
        }
        if (k.name === "return" || k.name === "tab") {
          // Accept the highlighted candidate; if none, dismiss and (for Enter)
          // fall through so the raw `@query` submits via the normal path.
          if (commitAtSelected()) {
            redraw()
            return
          }
          dismissAt(state.at)
          if (k.name === "tab") {
            redraw()
            return
          }
          // Enter with no selection: fall through to the normal submit below.
        } else if (k.name === "down") {
          state.at.selectedIdx = selectNext(state.at, visible)
          redraw()
          return
        } else if (k.name === "up") {
          state.at.selectedIdx = selectPrev(state.at, visible)
          redraw()
          return
        } else if (k.name === "backspace") {
          const verdict = classifyBackspace(state.at, state.cursor)
          if (verdict.kind === "dismiss") {
            // Erase the char then close the dropdown.
            if (state.cursor > 0) {
              state.buf = state.buf.slice(0, state.cursor - 1) + state.buf.slice(state.cursor)
              state.cursor -= 1
            }
            dismissAt(state.at)
            refreshCandidates()
            redraw()
            return
          }
          if (verdict.kind === "requery") {
            state.buf = state.buf.slice(0, state.cursor - 1) + state.buf.slice(state.cursor)
            state.cursor -= 1
            void runAtList()
            redraw()
            return
          }
        }
        // Any other key (printable char, Left/Right/Home/End, Delete) falls
        // through to the shared handlers below; the char branch re-queries.
      }

      if (k.name === "return") {
        if (state.listOpen && state.selectedIdx >= 0) commitSelected()
        // Heredoc multiline: a fence line opens/closes the body; a non-fence
        // line inside the body accumulates and the prompt resets to "… ".
        if (opts.multiline === true) {
          const fence = detectFence(state.buf)
          if (!state.heredocOpen && fence !== "") {
            // Open heredoc — the fence line itself is NOT included in the body.
            state.heredocOpen = true
            state.heredocFence = fence
            state.heredocLines = []
            state.buf = ""
            state.cursor = 0
            refreshCandidates()
            redraw()
            return
          }
          if (state.heredocOpen && fence === state.heredocFence) {
            // Close heredoc — submit the joined body.
            const body = state.heredocLines.join("\n")
            state.heredocOpen = false
            state.heredocFence = ""
            state.heredocLines = []
            state.buf = body
            state.cursor = body.length
            if (opts.history !== undefined && body !== "") opts.history.push(body)
            settleResolve(body)
            return
          }
          if (state.heredocOpen) {
            // Continuation: stash and reset prompt for the next line.
            state.heredocLines.push(state.buf)
            state.buf = ""
            state.cursor = 0
            refreshCandidates()
            redraw()
            return
          }
        }
        if (opts.history !== undefined) opts.history.push(state.buf)
        settleResolve(state.buf)
        return
      }

      if (k.name === "escape") {
        if (state.listOpen) {
          state.listOpen = false
          state.selectedIdx = -1
          redraw()
        }
        return
      }

      if (k.name === "tab") {
        if (state.listOpen && state.selectedIdx >= 0) {
          commitSelected()
        } else if (!acceptGhost() && state.candidates.length > 0) {
          state.listOpen = true
          state.selectedIdx = 0
        }
        redraw()
        return
      }

      if (k.name === "down") {
        if (state.listOpen && state.candidates.length > 0) {
          const visible = Math.min(state.candidates.length, MAX_VISIBLE_CANDIDATES)
          state.selectedIdx = (state.selectedIdx + 1) % visible
          redraw()
          return
        }
        if (opts.history !== undefined && !state.heredocOpen) {
          setBufFromHistory(opts.history.next())
          redraw()
        }
        return
      }

      if (k.name === "up") {
        if (state.listOpen && state.candidates.length > 0) {
          const visible = Math.min(state.candidates.length, MAX_VISIBLE_CANDIDATES)
          state.selectedIdx = state.selectedIdx <= 0 ? visible - 1 : state.selectedIdx - 1
          redraw()
          return
        }
        if (opts.history !== undefined && !state.heredocOpen) {
          const prev = opts.history.prev()
          if (prev !== undefined) {
            setBufFromHistory(prev)
            redraw()
          }
        }
        return
      }

      if (k.name === "right") {
        if (state.cursor === state.buf.length && ghostSuffix(state.buf, state.candidates) !== "") {
          acceptGhost()
        } else if (state.cursor < state.buf.length) {
          state.cursor += 1
        }
        redraw()
        return
      }

      if (k.name === "left") {
        if (state.cursor > 0) {
          state.cursor -= 1
          redraw()
        }
        return
      }

      if (k.name === "home") {
        state.cursor = 0
        redraw()
        return
      }

      if (k.name === "end") {
        state.cursor = state.buf.length
        redraw()
        return
      }

      if (k.name === "backspace") {
        if (state.cursor > 0) {
          state.buf = state.buf.slice(0, state.cursor - 1) + state.buf.slice(state.cursor)
          state.cursor -= 1
          if (state.historyDraft !== null) {
            state.historyDraft = null
            opts.history?.reset()
          }
          refreshCandidates()
          redraw()
        }
        return
      }

      if (k.name === "delete") {
        if (state.cursor < state.buf.length) {
          state.buf = state.buf.slice(0, state.cursor) + state.buf.slice(state.cursor + 1)
          if (state.historyDraft !== null) {
            state.historyDraft = null
            opts.history?.reset()
          }
          refreshCandidates()
          redraw()
        }
        return
      }

      if (typeof str === "string" && str.length > 0) {
        if (str === "\t" || str === "\r" || str === "\n") return
        if (str.length === 1 && str < " ") return
        // RFC-12 — classify the inserted char w.r.t. the `@`-dropdown BEFORE
        // the buffer mutation (the machine needs the pre-insert cursor for the
        // left-boundary check). A multi-char `str` is a paste ⇒ never opens.
        const isPaste = str.length > 1
        const insertAt = state.cursor
        const verdict =
          opts.atProvider !== undefined
            ? classifyChar({
                state: state.at,
                buf: state.buf,
                cursor: insertAt,
                ch: str,
                providerPresent: true,
                isPaste,
              })
            : ({ kind: "ignore" } as const)
        state.buf = state.buf.slice(0, state.cursor) + str + state.buf.slice(state.cursor)
        state.cursor += str.length
        // Any direct edit invalidates the history navigation context:
        // the buf no longer represents a recalled entry, so a follow-up `↓`
        // shouldn't try to restore a stale "draft".
        if (state.historyDraft !== null) {
          state.historyDraft = null
          opts.history?.reset()
        }
        refreshCandidates()
        if (verdict.kind === "open") {
          openAtDropdown(verdict.triggerPos)
        } else if (verdict.kind === "requery") {
          void runAtList()
        } else if (verdict.kind === "dismiss") {
          dismissAt(state.at)
        }
        redraw()
      }
    }

    stdin.on("keypress", onKey)
    // Initial paint: BG-styled prompt + (optional) meta row.
    growBandTo(targetReserved())
    redraw()
  })
}

const longestCommonPrefix = (candidates: readonly string[]): string => {
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

export const __longestCommonPrefixForTest = longestCommonPrefix
export const __stringColumnsForTest = stringColumns
export const __ghostSuffixForTest = ghostSuffix
