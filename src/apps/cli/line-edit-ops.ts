/**
 * jun-11 (R3 worklist #12) — pure word/line editing operations for the raw-line
 * reader's readline-style chords (ctrl+w / ctrl+u / ctrl+k / alt+b / alt+f).
 *
 * These were genuinely ABSENT: the reader only had single-char backspace/delete
 * and Home/End. Extracting the boundary logic here (pure, no IO, no state) keeps
 * it unit-testable without driving the raw-mode keypress machine — `raw-line-
 * reader.ts`'s onKey branches just call these and apply the result to
 * `state.buf` / `state.cursor`.
 *
 * Semantics (readline / Codex `TuiEditorKeymap` parity): a "word" is a maximal
 * run of non-whitespace; the kill-word / word-motion ops skip any intervening
 * whitespace FIRST, then cross the word. Slice ops are code-unit based — fine
 * for the ASCII-dominant prompt editing here (the reader's existing buf slices
 * are likewise code-unit based, so this is consistent, not a new hazard).
 */

export interface LineState {
  readonly buf: string
  readonly cursor: number
}

const isWS = (c: string | undefined): boolean => c === " " || c === "\t"

/** ctrl+w — delete the word before the cursor: skip trailing whitespace, then
 *  remove the preceding run of non-whitespace. No-op at column 0 (returns the
 *  SAME reference so the caller can cheaply detect "nothing changed"). */
export const deleteWordBefore = (s: LineState): LineState => {
  let i = s.cursor
  while (i > 0 && isWS(s.buf[i - 1])) i -= 1
  while (i > 0 && !isWS(s.buf[i - 1])) i -= 1
  if (i === s.cursor) return s
  return { buf: s.buf.slice(0, i) + s.buf.slice(s.cursor), cursor: i }
}

/** ctrl+u — kill from line start to the cursor. No-op (same ref) at column 0. */
export const killToLineStart = (s: LineState): LineState =>
  s.cursor === 0 ? s : { buf: s.buf.slice(s.cursor), cursor: 0 }

/** ctrl+k — kill from the cursor to the line end. No-op (same ref) at line end.
 *  Cursor is unchanged (stays where the kill began). */
export const killToLineEnd = (s: LineState): LineState =>
  s.cursor >= s.buf.length ? s : { buf: s.buf.slice(0, s.cursor), cursor: s.cursor }

/** alt+b — the column at the start of the previous word (skip whitespace, then
 *  the word). Returns the new cursor; 0 when already at/over the start. */
export const wordLeft = (s: LineState): number => {
  let i = s.cursor
  while (i > 0 && isWS(s.buf[i - 1])) i -= 1
  while (i > 0 && !isWS(s.buf[i - 1])) i -= 1
  return i
}

/** alt+f — the column at the end of the next word (skip whitespace, then the
 *  word). Returns the new cursor; clamped to buf length. */
export const wordRight = (s: LineState): number => {
  let i = s.cursor
  const n = s.buf.length
  while (i < n && isWS(s.buf[i])) i += 1
  while (i < n && !isWS(s.buf[i])) i += 1
  return i
}
