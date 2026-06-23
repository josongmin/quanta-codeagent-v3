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
 *
 *  Module layout: pure helpers (ANSI / column math, paste display, key-event
 *  rebuild, candidate-row rendering, shared types) live in `./raw-line-reader/`
 *  siblings and are re-exported below to preserve the public surface. The
 *  stateful `readLine` driver (+ its `onKey` keypress machine) stays here.
 */

import * as readline from "node:readline"
import {
  type AtCandidate,
  acceptSelected,
  atQuery,
  classifyBackspace,
  classifyChar,
  createAtState,
  dismiss as dismissAt,
  selectNext,
  selectPrev,
} from "./at-autocomplete"
import { CANONICAL_KEY_FOR_ACTION } from "./keybindings/defaults"
import { keyOf } from "./keybindings/normalize"
import {
  deleteWordBefore,
  killToLineEnd,
  killToLineStart,
  wordLeft,
  wordRight,
} from "./line-edit-ops"
import {
  CR,
  CYAN,
  DIM,
  DISABLE_BRACKETED_PASTE,
  ENABLE_BRACKETED_PASTE,
  ERASE_LINE,
  ESC,
  fillBgRow,
  GRAY,
  MAX_VISIBLE_CANDIDATES,
  moveDown,
  moveRight,
  moveUp,
  RESET,
  stringColumns,
  stripAnsi,
} from "./raw-line-reader/ansi"
import {
  cancelSearch,
  commitSearch,
  detectFence,
  setBufFromHistory,
  stepSearch,
} from "./raw-line-reader/history-search"
import { type KeyEvent, remapKeyEvent } from "./raw-line-reader/key-event"
import {
  AbortError,
  type ReaderStdin,
  type ReaderStdout,
  type ReadLineOptions,
  type ReadLineTestIO,
} from "./raw-line-reader/options"
import {
  accumulatePasteKey,
  beginPaste,
  finishPaste,
  isPasteEnd,
  isPasteStart,
} from "./raw-line-reader/paste-accum"
import { pasteBurstPlaceholder, projectPasteDisplay } from "./raw-line-reader/paste-display"
import {
  atListRows as atListRowsFor,
  ghostSuffix,
  renderListRows,
} from "./raw-line-reader/render-rows"
import { longestCommonPrefix, type State } from "./raw-line-reader/types"

export type { ReadLineOptions, ReadLineTestIO } from "./raw-line-reader/options"
// Re-export the complete public surface so every importer of
// `./raw-line-reader` stays byte-compatible after the split.
export { AbortError } from "./raw-line-reader/options"
export {
  type PasteBurstOptions,
  pasteBurstPlaceholder,
  projectPasteDisplay,
} from "./raw-line-reader/paste-display"
export type { CandidateDescriptor, CompleterFn, DescribeFn, State } from "./raw-line-reader/types"

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
      pasteSegments: [],
      pasting: false,
      pasteAnchor: 0,
      pasteText: "",
      pasteLastCR: false,
    }
    // Reset the history cursor at the start of every readLine so `↑` always
    // pulls the freshest entry first. Default-OFF when `opts.history` absent.
    opts.history?.reset()
    let settled = false
    // RFC-11 / ADR-0446 — `ctrl+x` chord prefix latch. Set when `ctrl+x` is
    // seen with `opts.openEditor` wired; a following `ctrl+e` opens the editor.
    // Any other key clears it. Inert when `opts.openEditor` is absent.
    let pendingCtrlX = false

    if (testIO?.skipKeypressSetup !== true) {
      readline.emitKeypressEvents(stdin as unknown as NodeJS.ReadStream)
    }
    const wasRaw = stdin.isTTY === true ? (stdin.isRaw ?? false) : false
    if (stdin.isTTY === true) stdin.setRawMode?.(true)
    stdin.resume()

    // #10 — bracketed-paste enable/disable. Guarded on the opt AND a real TTY so
    // the OFF path (and a non-tty test stdin) never emits the DECSET bytes
    // (byte-identical). `enable` is called on raw-mode entry + editor-resume;
    // `disable` on every exit (cleanup) + editor-suspend, so no terminal is ever
    // left with bracketed-paste latched after the reader yields or crashes.
    const bracketedPasteOn = opts.bracketedPaste === true
    const enableBracketedPaste = (): void => {
      if (bracketedPasteOn && stdin.isTTY === true) stdout.write(ENABLE_BRACKETED_PASTE)
    }
    const disableBracketedPaste = (): void => {
      if (bracketedPasteOn && stdin.isTTY === true) stdout.write(DISABLE_BRACKETED_PASTE)
    }
    enableBracketedPaste()

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
          ? atListRowsFor(state.at).length
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
      const listRows = state.listOpen
        ? renderListRows(state.listOpen, state.candidates, state.selectedIdx, opts.describe)
        : atDropdownOpen()
          ? atListRowsFor(state.at)
          : []
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
      // jun-6 — collapse recorded paste blobs to `[Pasted Content N chars]` for
      // the ECHO only. `buf` is unchanged (full text submits). No segments ⇒
      // `echoBuf === state.buf`, so the OFF / no-paste path is byte-identical.
      const echoBuf = projectPasteDisplay(state.buf, state.pasteSegments)
      out += fillBgRow(`${displayPrompt}${echoBuf}`)
      // Ghost text (only when list is closed AND cursor at end AND not in heredoc).
      if (!state.listOpen && !state.heredocOpen && state.cursor === state.buf.length) {
        const ghost = ghostSuffix(state.buf, state.candidates)
        if (ghost !== "") {
          // Repaint with ghost embedded inside the BG row.
          out += CR + ERASE_LINE
          out += fillBgRow(`${displayPrompt}${echoBuf}${DIM}${ghost}${RESET}`)
        }
      }
      // Cursor back to prompt line, buf cursor col. With paste placeholders the
      // cursor anchors to the END of the echo (a paste always lands the caret
      // after the collapsed blob); no segments ⇒ the original `buf.slice(0,
      // cursor)` width (byte-identical).
      const displayPromptCols = state.heredocOpen ? 2 : promptCols
      const cursorWidth =
        state.pasteSegments.length === 0
          ? stringColumns(state.buf.slice(0, state.cursor))
          : stringColumns(echoBuf)
      out += CR + moveRight(displayPromptCols + cursorWidth)
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
      // #10 — turn bracketed-paste OFF before restoring the prior raw-mode state
      // so the host terminal is never left with `?2004h` latched (it would wrap
      // the user's NEXT shell paste in stray `[200~`/`[201~` markers otherwise).
      disableBracketedPaste()
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
      // jun-6 — the final echo collapses paste blobs too (the transcript shows
      // `[Pasted Content N chars]`, not the raw blob). No segments ⇒
      // `echoBuf === state.buf` (byte-identical exit echo).
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

    // Heredoc fence detection + history-recall / reverse-i-search helpers live
    // in `./raw-line-reader/history-search`; they operate on `state` (+ refresh
    // / redraw callbacks) so the `onKey` routing below is byte-for-byte
    // equivalent. All inert unless `opts.history` is wired.

    // ── RFC-11 / ADR-0446 — external `$EDITOR` composition ──────────────────
    // Suspend raw mode + detach our keypress listener, yield the terminal to
    // `$EDITOR`, fold the edited draft back into `buf`, then RESTORE raw mode
    // and re-attach — the restore lives in `finally` so a throwing / crashing /
    // non-zero-exit editor can NEVER strand the terminal out of raw mode (the
    // #1 risk). `openEditor.openDraft` is itself no-throw, but the `finally`
    // remains the load-bearing safety net regardless.
    const runExternalEdit = async (): Promise<void> => {
      if (settled || opts.openEditor === undefined) return
      // Yield the terminal: stop receiving keypresses, erase the prompt band,
      // drop raw mode so the editor owns the TTY.
      stdin.removeListener("keypress", onKey)
      releaseBand()
      stdout.write(CR + ERASE_LINE)
      const draft = state.buf
      try {
        // #10 — drop bracketed-paste before handing the TTY to $EDITOR (the
        // editor manages its own paste mode); re-enabled in the finally on resume.
        disableBracketedPaste()
        if (stdin.isTTY === true) stdin.setRawMode?.(false)
        stdin.pause()
        // `openDraft` is contractually no-throw, but we still swallow a
        // rejection here so a misbehaving port can never escape as an
        // unhandled rejection — the `finally` below restores the terminal
        // regardless of how this resolves.
        try {
          const edited = await opts.openEditor.openDraft(draft)
          if (!settled) {
            state.buf = edited.text
            state.cursor = state.buf.length
          }
        } catch {
          /* editor port threw — draft kept; restore happens in finally */
        }
      } finally {
        // Restore the terminal no matter how the editor returned — unless a
        // ctrl-c settled the read while the editor was open (then `cleanup`
        // already restored `wasRaw` and we must not fight it).
        if (!settled) {
          if (stdin.isTTY === true) stdin.setRawMode?.(true)
          stdin.resume()
          // #10 — re-arm bracketed-paste now that we own the TTY again.
          enableBracketedPaste()
          if (testIO?.skipKeypressSetup !== true) {
            readline.emitKeypressEvents(stdin as unknown as NodeJS.ReadStream)
          }
          stdin.on("keypress", onKey)
          refreshCandidates()
          growBandTo(targetReserved())
          redraw()
        }
      }
    }

    // ── #10 — bracketed-paste accumulation ──────────────────────────────────
    // The accumulation helpers live in `./raw-line-reader/paste-accum`; they
    // operate on `state` (+ refresh / redraw callbacks) so the routing below is
    // byte-for-byte equivalent. Inert unless `bracketedPasteOn`.

    const onKey = (str: string | undefined, key: KeyEvent | undefined): void => {
      if (settled) return
      // RFC-11 — `k` is reassignable so the keybinding remap can rewrite the
      // event to its action's canonical default key in place (no downstream
      // churn). Absent map ⇒ never reassigned (byte-identical).
      let k = key ?? {}

      // #10 — bracketed paste. While pasting, route EVERY keypress to
      // accumulation so an embedded `\r` never reaches the submit branch.
      // Placed ABOVE ctrl+c so content between the markers is literal data.
      // Inert (whole block skipped) unless `bracketedPasteOn` (byte-identical).
      if (bracketedPasteOn) {
        if (state.pasting) {
          if (isPasteEnd(k)) {
            finishPaste(state, opts, refreshCandidates, redraw)
            return
          }
          accumulatePasteKey(state, str, k)
          return
        }
        if (isPasteStart(k)) {
          beginPaste(state)
          return
        }
      }

      if (k.ctrl === true && k.name === "c") {
        settleReject(new AbortError())
        return
      }

      // RFC-11 / ADR-0446 — `ctrl+x ctrl+e` chord ⇒ open the external editor.
      // The chord state machine runs ONLY when `opts.openEditor` is wired, so
      // absent ⇒ this whole block is skipped and ctrl-x / ctrl-e stay the
      // control chars the printable-insert path already drops (byte-identical).
      // Placed BELOW ctrl-c (abort always wins) and ABOVE search/at routing so a
      // pending chord cannot be swallowed by another mode. Disjoint from the
      // RFC-08 backtab guard and the RFC-12 `@` routing (neither uses ctrl+x).
      if (opts.openEditor !== undefined) {
        if (pendingCtrlX) {
          pendingCtrlX = false
          if (k.ctrl === true && k.name === "e") {
            void runExternalEdit()
            return
          }
          // Any other key after ctrl-x: abandon the chord and let the key fall
          // through to its normal handler below.
        } else if (k.ctrl === true && k.name === "x") {
          pendingCtrlX = true
          return
        }
      }

      // RFC-11 / ADR-0447 — user keybinding remap. When a map is injected, the
      // incoming key is projected to its bound action; if that action's
      // canonical default key differs, the event is REWRITTEN to the default key
      // so the existing if-chain (with all its context logic) handles it
      // unchanged. `open-editor` is intercepted directly. Absent map ⇒ no
      // projection, the original `k` flows on (byte-identical). The default
      // bindings are an identity remap, so even an injected DEFAULT map is a
      // no-op for behavior.
      if (opts.keybindings !== undefined) {
        const chord = keyOf(k)
        const action = chord !== null ? opts.keybindings.get(chord) : undefined
        if (action === "open-editor") {
          if (opts.openEditor !== undefined) void runExternalEdit()
          return
        }
        if (action !== undefined) {
          const canonical = CANONICAL_KEY_FOR_ACTION.get(action)
          // Only single-chord canonical keys are routed here (chord SEQUENCES
          // like `ctrl+x ctrl+e` are owned by the prefix machine above).
          if (canonical !== undefined && !canonical.includes(" ") && canonical !== chord) {
            k = remapKeyEvent(canonical)
          }
        }
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
          commitSearch(state, refreshCandidates)
          settleResolve(state.buf)
          return
        }
        if (k.name === "escape" || (k.ctrl === true && k.name === "g")) {
          cancelSearch(state)
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
          stepSearch(state, opts.history, redraw)
          return
        }
        if (typeof str === "string" && str.length === 1 && str >= " ") {
          state.searchQuery += str
          stepSearch(state, opts.history, redraw)
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
        // Navigate the FULL candidate list (the render window scrolls to keep
        // the selection visible — see atListRows), so entries past the visible
        // window are reachable instead of stranded.
        const total = state.at.candidates.length
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
          state.at.selectedIdx = selectNext(state.at, total)
          redraw()
          return
        } else if (k.name === "up") {
          state.at.selectedIdx = selectPrev(state.at, total)
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
          setBufFromHistory(state, opts.history.next(), refreshCandidates)
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
            setBufFromHistory(state, prev, refreshCandidates)
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

      // jun-11 (#12) — readline-style word/line editing. Placed before the char-
      // insertion block so the control chars (\x17/\x15/\x0b) are consumed here
      // instead of being dropped by the `str < " "` guard. Kill ops mirror
      // backspace's bookkeeping (history-draft reset + candidate refresh); the
      // pure boundary logic lives in `line-edit-ops.ts` (unit-tested). With the
      // keybinding layer on, ctrl+a/ctrl+e are remapped onto the Home/End
      // branches above (canonical key), so they need no branch here; when the
      // layer is OFF the explicit ctrl+a/ctrl+e branch below covers them.
      if (k.ctrl === true && (k.name === "w" || k.name === "u" || k.name === "k")) {
        const cur = { buf: state.buf, cursor: state.cursor }
        const next =
          k.name === "w"
            ? deleteWordBefore(cur)
            : k.name === "u"
              ? killToLineStart(cur)
              : killToLineEnd(cur)
        if (next.buf !== state.buf || next.cursor !== state.cursor) {
          state.buf = next.buf
          state.cursor = next.cursor
          if (state.historyDraft !== null) {
            state.historyDraft = null
            opts.history?.reset()
          }
          refreshCandidates()
          redraw()
        }
        return
      }

      if (k.ctrl === true && (k.name === "a" || k.name === "e")) {
        state.cursor = k.name === "a" ? 0 : state.buf.length
        redraw()
        return
      }

      if (k.meta === true && (k.name === "b" || k.name === "f")) {
        state.cursor =
          k.name === "b"
            ? wordLeft({ buf: state.buf, cursor: state.cursor })
            : wordRight({ buf: state.buf, cursor: state.cursor })
        redraw()
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
        // jun-6 (Codex paste-burst) — a SINGLE keypress carrying ≥minChars chars
        // is a large paste: record it so the ECHO collapses to `[Pasted Content
        // N chars]` while `buf` (just spliced above) keeps the FULL text for
        // submission. Detection is chunk-SIZE only (no clock). Default-OFF
        // (`opts.pasteBurst` undefined) ⇒ this is skipped and the paste echoes
        // inline exactly as before (byte-identical). The char count is the
        // code-point length (Unicode-safe), matching what the user pasted.
        if (opts.pasteBurst !== undefined) {
          const charCount = [...str].length
          if (charCount >= opts.pasteBurst.minChars) {
            state.pasteSegments.push({
              text: str,
              placeholder: pasteBurstPlaceholder(charCount),
            })
          }
        }
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

export const __longestCommonPrefixForTest = longestCommonPrefix
export const __stringColumnsForTest = stringColumns
export const __ghostSuffixForTest = ghostSuffix
