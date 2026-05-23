/**
 * Pure progress formatter for `BranchTraceEvent`s — turns a trace event into
 * a single human-readable line + severity classification. Plane-clean: imports
 * ONLY from `./types`. No I/O, no clock, no allocation beyond the line itself.
 *
 * The CLI wraps this with its writer of choice (`config.onProgress`); test
 * suites assert against the deterministic textual output. ANSI coloring + the
 * unicode glyph set are both opt-in, default-on for human display, default-off
 * for tests that diff exact strings.
 */

import type { BranchTraceEvent } from "./types"

export interface ProgressLine {
  readonly text: string
  readonly severity: "info" | "success" | "warning" | "error"
}

export interface ProgressFormatOpts {
  /** ANSI escape codes around the line per severity. Default `false`. */
  readonly colors?: boolean
  /** Unicode glyphs in the prefix. Default `true`. When `false`, the glyph
   *  collapses to a plain-ASCII fallback so terminals without UTF-8 still
   *  render legibly. */
  readonly useUnicode?: boolean
}

const ANSI: Readonly<Record<ProgressLine["severity"], string>> = Object.freeze({
  info: "",
  success: "\x1b[32m",
  warning: "\x1b[33m",
  error: "\x1b[31m",
})
const ANSI_RESET = "\x1b[0m"

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`

const wrap = (text: string, severity: ProgressLine["severity"], colors: boolean): string => {
  if (!colors || severity === "info") return text
  const open = ANSI[severity]
  if (open === "") return text
  return `${open}${text}${ANSI_RESET}`
}

interface Glyphs {
  readonly started: string
  readonly finished: string
  readonly failed: string
  readonly scored: string
  readonly delta: string
  readonly winner: string
  readonly anchor: string
}

const UNICODE_GLYPHS: Glyphs = Object.freeze({
  started: "▶", // ▶
  finished: "✓", // ✓
  failed: "✗", // ✗
  scored: "·", // ·
  delta: "Δ", // Δ
  winner: "★", // ★
  anchor: "⚠", // ⚠
})

const ASCII_GLYPHS: Glyphs = Object.freeze({
  started: ">",
  finished: "+",
  failed: "!",
  scored: ".",
  delta: "D",
  winner: "*",
  anchor: "!",
})

/** Format a single `BranchTraceEvent` for human display. Pure, deterministic,
 *  no I/O. The CLI calls this from `config.onProgress` (or wraps it in its
 *  own writer); test suites assert exact text. */
export const formatBranchTrace = (
  event: BranchTraceEvent,
  opts?: ProgressFormatOpts,
): ProgressLine => {
  const useUnicode = opts?.useUnicode !== false
  const colors = opts?.colors === true
  const g = useUnicode ? UNICODE_GLYPHS : ASCII_GLYPHS

  switch (event.kind) {
    case "candidate-started": {
      const text = `${g.started} candidate ${event.id} started`
      return { text: wrap(text, "info", colors), severity: "info" }
    }
    case "candidate-finished": {
      const text = `${g.finished} candidate ${event.id} finished (${plural(event.turns, "turn")}, ${event.durationMs}ms)`
      return { text: wrap(text, "info", colors), severity: "info" }
    }
    case "candidate-failed": {
      if (event.id === "anchor") {
        const text = `${g.anchor} anchor registration failed: ${event.reason}`
        return { text: wrap(text, "warning", colors), severity: "warning" }
      }
      const text = `${g.failed} candidate ${event.id} failed: ${event.reason}`
      return { text: wrap(text, "warning", colors), severity: "warning" }
    }
    case "candidate-scored": {
      const text = `${g.scored} candidate ${event.id} scored ${event.total.toFixed(3)}`
      return { text: wrap(text, "info", colors), severity: "info" }
    }
    case "candidate-delta": {
      const { addedLines, removedLines, changedFiles } = event.delta
      const detail = `+${addedLines}/-${removedLines}, ${plural(changedFiles, "file")}`
      const text = `${g.delta} candidate ${event.id} delta: ${detail}`
      return { text: wrap(text, "info", colors), severity: "info" }
    }
    case "winner-selected": {
      const text = `${g.winner} winner: candidate ${event.winnerId} (score ${event.total.toFixed(3)})`
      return { text: wrap(text, "success", colors), severity: "success" }
    }
  }
}
