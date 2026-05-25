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

const ESC = "\x1b["
const SAVE_CURSOR = `${ESC}s`
const RESTORE_CURSOR = `${ESC}u`
const ERASE_LINE = `${ESC}2K`
const FG_DIM = `${ESC}2m`
const FG_RESET = `${ESC}22;39m`

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

export const installStatusBar = (initialText: string): StatusBar => {
  let defaultText = initialText
  let currentText = initialText
  let transientTimer: ReturnType<typeof setTimeout> | null = null
  let installed = false

  const setupScrollRegion = (): void => {
    const rows = termRows()
    // DECSTBM: set scroll region to lines [1, rows-1]. The last row
    // (rows) is now outside the scroll region — stdout writes never
    // touch it, so the status bar persists across LLM streams.
    process.stderr.write(`${ESC}1;${rows - 1}r`)
    // Park the cursor inside the scroll region so the first stdout
    // write doesn't accidentally land on the status row.
    process.stderr.write(`${ESC}${rows - 1};1H`)
    installed = true
  }

  const paintRow = (text: string): void => {
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
    currentText = text
  }

  const cancelTransient = (): void => {
    if (transientTimer !== null) {
      clearTimeout(transientTimer)
      transientTimer = null
    }
  }

  setupScrollRegion()
  paintRow(initialText)

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
      if (!installed) return
      cancelTransient()
      const rows = termRows()
      // Reset scroll region to full screen, clear the status row, leave
      // cursor on the first column of the (former) status row so the
      // shell prompt that follows quanta exit starts on a clean line.
      process.stderr.write(
        `${ESC}r` + `${ESC}${rows};1H` + ERASE_LINE + `${ESC}${rows};1H`,
      )
      installed = false
      void currentText
    },
  }
}
