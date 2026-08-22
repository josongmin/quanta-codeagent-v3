/** Fixed bottom status bar via ANSI scroll-region (DECSTBM).
 *
 *  Sets the terminal's scrollable region to rows [1..N-1] so the very
 *  last terminal row is reserved for a vim-style status line. The status
 *  line is repainted via cursor-jump + erase-line + repaint + restore;
 *  it never gets scrolled out by stdout / LLM stream output.
 *
 *  Transient overlay messages (e.g. "Press Esc again to cancel") replace
 *  the default text and auto-revert after `transientMs`. The bar tracks
 *  the most recent default text so a revert after a transient lands on
 *  the live state, not a stale snapshot.
 *
 *  Teardown resets the scroll region and clears the status row so any
 *  subsequent shell prompt (after quanta exits) starts clean.
 */

import {
  acquireRegion as acquireSharedRegion,
  DEC_RESTORE_CURSOR,
  DEC_SAVE_CURSOR,
  onTerminalResize,
  type RegionHandle,
  type ResizeSubscribe,
  type ScrollRegionManager,
} from "./terminal-chrome"

const ESC = "\x1b["
// DECSC / DECRC (`ESC 7` / `ESC 8`) — the DEC private cursor save/restore,
// imported from the WS-C terminal-chrome kernel (the SSOT; SCO `ESC[s` is
// grep-gate banned there). Preferred over SCO because xterm/iTerm2/
// Terminal.app/tmux/VSCode/screen all implement DEC fully; SCO restore is
// unreliable on VSCode-integrated and some legacy emulators, which causes
// the next stdout write to land at the status-row position instead of
// returning to the streamed content — showing as " · 29.6k in · 33 out"
// suffixes leaking onto every content line.
const SAVE_CURSOR = DEC_SAVE_CURSOR
const RESTORE_CURSOR = DEC_RESTORE_CURSOR
const ERASE_LINE = `${ESC}2K`
const FG_DIM = `${ESC}2m`
const FG_RESET = `${ESC}22;39m`

/** Truthy/falsy knob parser for env strings ("0", "off", "false", "no"). */
const isEnvFalsy = (v: string | undefined): boolean => {
  if (v === undefined) return false
  const n = v.trim().toLowerCase()
  return n === "0" || n === "false" || n === "off" || n === "no"
}

/** Decide whether the bottom status row can render reliably in this surface.
 *
 *  Returns `false` (callers should install a no-op stub) when any of:
 *   - `stderr` is not a TTY (pipe / redirect / non-interactive)
 *   - `$TERM=dumb` (Emacs comint, some CI shells — no DECSTBM)
 *   - `QUANTA_STATUSBAR=0` / `off` / `false` / `no` (operator override)
 *
 *  Pure function — no global reads — so the call site is fully testable. */
export const isStatusBarSupported = (
  env: NodeJS.ProcessEnv,
  stderrIsTTY: boolean | undefined,
): boolean => {
  if (stderrIsTTY !== true) return false
  if ((env.TERM ?? "").trim().toLowerCase() === "dumb") return false
  if (isEnvFalsy(env.QUANTA_STATUSBAR)) return false
  return true
}

const NOOP: StatusBar = {
  setDefault: (): void => undefined,
  transient: (): void => undefined,
  clearTransient: (): void => undefined,
  teardown: (): void => undefined,
}

/** Headless stub — paints nothing, accepts every call. Returned by
 *  {@link installStatusBar} when {@link isStatusBarSupported} says no. */
export const createNoopStatusBar = (): StatusBar => NOOP

const termRows = (): number => {
  const r = process.stderr.rows
  return typeof r === "number" && r > 2 ? r : 24
}
const termCols = (): number => {
  const c = process.stderr.columns
  return typeof c === "number" && c > 0 ? c : 80
}

export interface StatusBar {
  /** Replace the default text painted on the status row. */
  readonly setDefault: (text: string) => void
  /** Paint a transient overlay; reverts to the latest default after
   *  `ms` (default 2 s) or when `clearTransient()` is called. */
  readonly transient: (text: string, ms?: number) => void
  /** Immediately re-paint the default text (cancel any transient). */
  readonly clearTransient: () => void
  /** Reset the scroll region + clear the status row. Idempotent. */
  readonly teardown: () => void
}

export const installStatusBar = (
  initialText: string,
  options: {
    readonly env?: NodeJS.ProcessEnv
    readonly stderrIsTTY?: boolean
    /** WS-C — resize-subscription seam. Default: the singleton SIGWINCH
     *  registry ({@link onTerminalResize}); tests inject a fake. On resize
     *  the bar re-pins its DECSTBM region and repaints the live text. */
    readonly resize?: ResizeSubscribe
    /** WS-C — scroll-region manager seam. Default: the shared singleton so
     *  the bar, the timeline panel and the input lane never fight over the
     *  terminal-global DECSTBM state. */
    readonly regionManager?: ScrollRegionManager
  } = {},
): StatusBar => {
  const env = options.env ?? process.env
  const stderrIsTTY = options.stderrIsTTY ?? process.stderr.isTTY
  // Auto-disable on unsupported surfaces (non-TTY, dumb terminal, opt-out env)
  // — return a no-op stub so existing callers don't need to branch. This is
  // what prevents the SCO-restore leak from polluting content on terminals
  // that don't honour cursor save/restore.
  if (!isStatusBarSupported(env, stderrIsTTY)) return createNoopStatusBar()

  let defaultText = initialText
  let currentText = initialText
  let transientTimer: ReturnType<typeof setTimeout> | null = null
  let installed = false
  let region: RegionHandle | null = null

  const stderrWrite = (chunk: string): void => {
    process.stderr.write(chunk)
  }

  const regionBytes = (): string => {
    const rows = termRows()
    // DECSTBM: set scroll region to lines [1, rows-1]. The last row
    // (rows) is now outside the scroll region — stdout writes never
    // touch it, so the status bar persists across LLM streams. Followed by
    // a cursor park inside the scroll region so the first stdout write
    // doesn't accidentally land on the status row. Thunk — re-reads the
    // geometry so a resize refresh/resume re-pins against current rows.
    return `${ESC}1;${rows - 1}r${ESC}${rows - 1};1H`
  }

  const releaseBytes = (): string => {
    const rows = termRows()
    // Reset scroll region to full screen, clear the status row, leave
    // cursor on the first column of the (former) status row so the
    // shell prompt that follows quanta exit starts on a clean line.
    return `${ESC}r${ESC}${rows};1H${ERASE_LINE}${ESC}${rows};1H`
  }

  const setupScrollRegion = (): void => {
    // WS-C — the DECSTBM pin goes through the scroll-region manager
    // (exactly one active owner; the mid-turn input lane suspends us and
    // our region is re-established when it exits).
    const acquire = options.regionManager?.acquireRegion ?? acquireSharedRegion
    region = acquire("status-bar", {
      establish: regionBytes,
      release: releaseBytes,
      write: stderrWrite,
      // Audit-R1 (suspended-paint) — the bar paints the physical bottom row;
      // while a LATER bottom-row owner (the mid-turn input lane) is stacked
      // above, content paints are gated, and this hook repaints the tracked
      // text the moment the row is free again.
      occupiesBottomRow: true,
      onBottomRowFreed: (): void => paintRow(currentText),
    })
    installed = true
  }

  const paintRow = (text: string): void => {
    // Audit-R1 (suspended-paint, UUX-5-04 second half) — while a bottom-row
    // OCCLUDER (the mid-turn input lane) is stacked above us, OUR row is the
    // operator's input row. Track the text (so the freed hook paints the live
    // state) but write NOTHING: a transient ("Press Esc again…"), its expiry
    // revert, or a resize repaint must never overwrite in-flight typing.
    // NOTE: suspension by a NON-bottom-row owner (timeline band) is NOT a
    // conflict — the bar keeps painting (the row is outside every region).
    currentText = text
    if (region?.isBottomRowOccluded()) return
    const rows = termRows()
    const cols = termCols()
    // Reserve 1 col for the leading space inside the painted band, so the
    // total visible width is exactly `cols`. Writing `cols + 1` visible chars
    // on a `cols`-wide row triggers DECAWM auto-wrap from the bottom row
    // (outside the scroll region) → whole screen scrolls up by one line per
    // paint, leaving the previous status line as a ghost in the scroll
    // region. Capping display at `cols - 1` keeps the cursor in-row.
    const maxDisplay = Math.max(0, cols - 1)
    const display = text.length > maxDisplay ? text.slice(0, maxDisplay) : text
    const pad = " ".repeat(Math.max(0, maxDisplay - display.length))
    process.stderr.write(
      SAVE_CURSOR +
        `${ESC}${rows};1H` +
        ERASE_LINE +
        `${FG_DIM} ${display}${pad}${FG_RESET}` +
        RESTORE_CURSOR,
    )
  }

  const cancelTransient = (): void => {
    if (transientTimer !== null) {
      clearTimeout(transientTimer)
      transientTimer = null
    }
  }

  setupScrollRegion()
  paintRow(initialText)

  // WS-C (UUX-5-03) — track terminal resizes: re-pin the DECSTBM region for
  // the new row count and repaint whatever text is live (default or
  // transient) at the new bottom row / width. Unsubscribed on teardown.
  const subscribeResize = options.resize ?? onTerminalResize
  const unsubscribeResize = subscribeResize((): void => {
    if (!installed) return
    region?.refresh()
    paintRow(currentText)
  })

  return {
    setDefault: (text: string): void => {
      defaultText = text
      if (transientTimer === null) paintRow(text)
    },
    transient: (text: string, ms = 2000): void => {
      cancelTransient()
      paintRow(text)
      transientTimer = setTimeout(() => {
        transientTimer = null
        paintRow(defaultText)
      }, ms)
    },
    clearTransient: (): void => {
      cancelTransient()
      paintRow(defaultText)
    },
    teardown: (): void => {
      // Always drop the resize subscription (idempotent) so a REPL restart
      // cannot accumulate SIGWINCH listeners.
      unsubscribeResize()
      if (!installed) return
      cancelTransient()
      // Release the DECSTBM region via the manager — writes the same
      // reset + clear-row bytes as before when we are the active owner.
      region?.release()
      region = null
      installed = false
      void currentText
    },
  }
}
