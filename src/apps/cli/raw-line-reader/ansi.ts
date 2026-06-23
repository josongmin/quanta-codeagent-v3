/** Raw-line-reader ANSI / escape-sequence primitives + terminal column math.
 *  Pure, dependency-free helpers extracted from `raw-line-reader.ts` so the
 *  reader module stays under the god-module threshold. The public reader API
 *  re-exports nothing from here — these are internal rendering utilities shared
 *  between the reader and its row-render sibling. */

export const ESC = "\x1b["
export const ERASE_LINE = `${ESC}2K`
export const ERASE_LINE_RIGHT = `${ESC}0K`
export const CR = "\r"
export const moveUp = (n: number): string => (n > 0 ? `${ESC}${n}A` : "")
export const moveDown = (n: number): string => (n > 0 ? `${ESC}${n}B` : "")
export const moveRight = (n: number): string => (n > 0 ? `${ESC}${n}C` : "")
export const DIM = `${ESC}2m`
export const RESET = `${ESC}0m`
export const CYAN = `${ESC}36m`
export const GRAY = `${ESC}90m`
export const REVERSE = `${ESC}7m`
// #10 — DECSET 2004: bracketed-paste enable / disable. Emitted only when
// `opts.bracketedPaste` is set so the OFF path never writes these bytes.
export const ENABLE_BRACKETED_PASTE = `${ESC}?2004h`
export const DISABLE_BRACKETED_PASTE = `${ESC}?2004l`

// biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately matches ANSI SGR sequences to strip them.
const ANSI_RE = /\x1b\[[0-9;]*m/g
export const stripAnsi = (s: string): string => s.replace(ANSI_RE, "")

export const charColumns = (ch: string): number => {
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

export const stringColumns = (s: string): number => {
  let cols = 0
  for (const ch of s) cols += charColumns(ch)
  return cols
}

export const MAX_VISIBLE_CANDIDATES = 8

/** Render a composer row. Previously this wrapped the content in a
 *  full-width dark-gray (xterm 236) background band so the prompt looked
 *  like a Codex-style "input box"; on dark terminal themes that band read
 *  as a solid black bar, so it now passes content through unchanged.
 *  The caller already emits `CR + ERASE_LINE` before each paint, so no
 *  width-padding is needed to overwrite stale content. */
export const fillBgRow = (content: string): string => content
