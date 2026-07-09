/**
 * §11.5 / ticket-08b — mid-turn input VISIBILITY (the bottom-anchored input
 * lane).
 *
 * RCA of the gap: `in-turn-reader.ts` captures keystrokes while a turn streams,
 * but writes NOTHING to stdout (a deliberate "no contention" choice), so the
 * user types BLIND — no echoed line, no cursor. This module is the PURE render
 * half: it builds the ANSI byte sequence that draws (or clears) a one-row lane
 * pinned to the TERMINAL BOTTOM, leaving the streamed agent output above it
 * untouched. The reader/session-loop owns the (impure) stdout write + the TTY +
 * knob gate; this module is pure so the exact escape bytes are hellgate-pinnable.
 *
 * Lane mechanics (DEC ANSI, terminal-portable):
 *   ESC 7        save cursor      (DECSC)
 *   ESC [ r;1 H  move to (row,1)  (CUP — `row` = terminal rows ⇒ bottom)
 *   ESC [ 2K     erase whole line (EL2)
 *   <prompt+buf> the live input
 *   ESC 8        restore cursor   (DECRC — streamed output resumes where it was)
 */

import { DEC_RESTORE_CURSOR, DEC_SAVE_CURSOR } from "../terminal-chrome"

// WS-C — cursor save/restore comes from the terminal-chrome kernel (the DEC
// SSOT; SCO `ESC[s`/`ESC[u` is grep-gate banned under src/apps/cli).
const SAVE = DEC_SAVE_CURSOR
const RESTORE = DEC_RESTORE_CURSOR
const ERASE_LINE = "\x1b[2K"
const cursorTo = (row: number, col: number): string => `\x1b[${row};${col}H`

/** Default lane prompt (distinct from the between-turns `> ` so the user can
 *  tell a mid-turn steer apart from a normal prompt). */
export const INPUT_LANE_PROMPT = "» "

export interface InputLaneGeometry {
  /** Terminal row count (`process.stdout.rows`); the lane pins to this row. */
  readonly rows: number
  /** Terminal column count (`process.stdout.columns`); when set, an over-long
   *  `prompt+buffer` keeps its TAIL visible (the caret end the user is typing). */
  readonly cols?: number
  /** Lane prompt; defaults to {@link INPUT_LANE_PROMPT}. */
  readonly prompt?: string
}

/** Draw the input lane at the terminal bottom with `buffer` after the prompt.
 *  Pure — returns the exact ANSI byte string (cursor saved/restored so the
 *  streamed output above is undisturbed). An empty buffer renders the bare
 *  prompt; use {@link clearInputLane} to remove the lane entirely. */
export const renderInputLane = (buffer: string, geom: InputLaneGeometry): string => {
  const prompt = geom.prompt ?? INPUT_LANE_PROMPT
  const row = Math.max(1, Math.floor(geom.rows) || 1)
  let line = prompt + buffer
  if (geom.cols !== undefined && geom.cols > 0 && line.length > geom.cols) {
    // Audit R1 #2 — keep the PROMPT (the mid-turn-mode visual cue) + the buffer
    // TAIL (where the caret is). Reserve the prompt; truncate only the buffer to
    // what's left. When cols ≤ prompt width (a degenerate tiny terminal) fall back
    // to the bare buffer tail so we never drop the caret end.
    const avail = geom.cols - prompt.length
    line =
      avail > 0
        ? prompt + buffer.slice(Math.max(0, buffer.length - avail))
        : buffer.slice(Math.max(0, buffer.length - geom.cols))
  }
  return SAVE + cursorTo(row, 1) + ERASE_LINE + line + RESTORE
}

/** Erase the lane (e.g. after Enter flushes the line or the buffer empties).
 *  Pure — saves/restores the cursor so streamed output is undisturbed. */
export const clearInputLane = (geom: Pick<InputLaneGeometry, "rows">): string => {
  const row = Math.max(1, Math.floor(geom.rows) || 1)
  return SAVE + cursorTo(row, 1) + ERASE_LINE + RESTORE
}

/** Audit R2#1 — ENTER lane mode: set the DECSTBM scroll region to rows 1..r-1 so
 *  the turn's streamed output scrolls ABOVE the lane and never overwrites/​scrolls
 *  the bottom row the lane owns (this is what makes the save/restore lane redraw
 *  safe against streaming, vs the naive interleave the original reader avoided).
 *  Parks the cursor at the bottom of the scroll region so streaming resumes
 *  there. Pure; the session loop writes it once before the in-turn reader runs.
 *  A <2-row terminal can't host a lane ⇒ empty string (no region change). */
export const enterLaneMode = (rows: number): string => {
  const r = Math.floor(rows) || 0
  if (r < 2) return ""
  return `\x1b[1;${r - 1}r` + cursorTo(r - 1, 1)
}

/** Audit R2#2 — EXIT lane mode: reset the scroll region to the full screen, erase
 *  the lane row (no stale `» buffer` artifact after the turn), and park the
 *  cursor on the (now-clear) lane row for the next prompt. Pure; written once in
 *  the reader's `finally`. Mirror of {@link enterLaneMode}; no-op under 2 rows. */
export const exitLaneMode = (rows: number): string => {
  const r = Math.floor(rows) || 0
  if (r < 2) return ""
  return `\x1b[r${cursorTo(r, 1)}${ERASE_LINE}`
}
