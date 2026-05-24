/**
 * Pure CSV/TSV parser (ADR-0133 — text-format structured-data tools).
 *
 * # Why this exists
 *
 * `csv_read` (and any future caller) needs an RFC-4180-aware splitter that:
 *  1. Handles quoted fields (`"x, y"`), escaped quotes (`""`), and embedded
 *     CR/LF inside quoted cells.
 *  2. Tolerates CRLF / LF / mixed line terminators in the same input.
 *  3. Reports malformed rows (unterminated quote, ragged column count) as
 *     typed {@link CsvParseDiagnostic}s INSTEAD OF throwing — exactly the
 *     same no-throw posture as `@/git/conflict-parser`.
 *
 * # Contract
 *
 *  1. **Pure.** No I/O, no `Buffer`, no `Bun.file`. Input is a `string`,
 *     output is the typed {@link CsvParseResult}.
 *  2. **No-throw.** Domain failures produce a {@link CsvParseDiagnostic}; only
 *     a non-string input throws ({@link CsvParserInputError} — programmer bug,
 *     not a domain failure).
 *  3. **exactOptionalPropertyTypes.** Optional fields on the result types
 *     (none today on the cell/row, only on the result envelope when extended)
 *     are OMITTED when absent, never set to `undefined`.
 *  4. **Plane-clean.** Imports nothing. Pure logic, zero deps.
 *
 * # Algorithm (state machine)
 *
 * Two states: `Field` (between quotes / between delimiters) and `Quoted`
 * (inside a `"…"` cell). Transitions:
 *   - Field + `"` (at start of cell) → Quoted
 *   - Quoted + `"` followed by `"` → emit `"`, stay Quoted (RFC 4180 escape)
 *   - Quoted + `"` (anything else) → Field
 *   - Field + delimiter → push cell, start new cell
 *   - Field + `\n` (or `\r\n`) → push cell, push row, advance line
 *   - Quoted + `\n` → embedded newline inside cell (preserved verbatim)
 *
 * # Unterminated quote
 *
 * EOF while still in `Quoted` ⇒ emit a `unterminated-quote` diagnostic at the
 * line where the open quote was seen, and push the partial cell + row as-is
 * (best-effort recovery — the caller can decide whether to drop the row).
 *
 * # Ragged rows
 *
 * If a row has a different cell count than the headers (or than row 0 when
 * `noHeader: true`), emit a `ragged-row` diagnostic. The row is STILL emitted
 * — callers can decide whether to drop it. The `column` field on the
 * diagnostic is OMITTED when not applicable.
 */

/** One parsed cell. `column` is the 1-indexed column position within the row. */
export interface CsvCell {
  readonly raw: string
  readonly column: number
}

/** One parsed row + the 1-indexed source line where it STARTED (a row can span
 *  multiple physical lines when a cell contains a quoted newline). */
export interface CsvRow {
  readonly cells: ReadonlyArray<CsvCell>
  readonly lineNumber: number
}

/** Closed union — extending requires every exhaustive switch to be updated. */
export interface CsvParseDiagnostic {
  readonly kind: "unterminated-quote" | "ragged-row" | "empty-input"
  readonly line: number
  readonly message: string
  /** 1-indexed column where the diagnostic was raised, when applicable.
   *  OMITTED (not `undefined`) under exactOptionalPropertyTypes when absent. */
  readonly column?: number
}

export interface CsvParseResult {
  /** Headers when `noHeader` is false (default) and at least one row was read.
   *  `null` when `noHeader: true` was set OR the input was empty. */
  readonly headers: ReadonlyArray<string> | null
  /** Data rows. When `noHeader` is false, this EXCLUDES the header row. */
  readonly rows: ReadonlyArray<CsvRow>
  readonly diagnostics: ReadonlyArray<CsvParseDiagnostic>
}

export interface CsvParseOpts {
  /** Field delimiter. Default `","`. Use `"\t"` for TSV. Must be exactly one
   *  character; longer values are treated as the first char (no throw). */
  readonly delimiter?: string
  /** Treat the first row as data (no headers). Default false. */
  readonly noHeader?: boolean
}

/** Thrown ONLY when the input is not a string (programmer bug — not a domain
 *  failure). Malformed input is reported via {@link CsvParseDiagnostic}. */
export class CsvParserInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CsvParserInputError"
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

/** Internal mutable row-accumulator. Frozen into a {@link CsvRow} on push. */
interface RowBuf {
  cells: string[]
  lineNumber: number
}

const freezeRow = (buf: RowBuf): CsvRow => ({
  cells: buf.cells.map((raw, i) => Object.freeze({ raw, column: i + 1 })),
  lineNumber: buf.lineNumber,
})

/** Mutable cursor state threaded through the two state-machine handlers.
 *  Kept as a struct (not destructured args) so the handlers can mutate in
 *  place without juggling tuples. */
interface TokenizerState {
  rows: RowBuf[]
  cur: RowBuf
  cellIdx: number
  line: number
  /** index advance for the OUTER loop: 0 means just `i++`, 1 means skip the
   *  next char (CRLF or `""` look-ahead consumed). */
  skipNext: boolean
  quoted: boolean
  openQuoteLine: number
}

const appendChar = (st: TokenizerState, ch: string): void => {
  st.cur.cells[st.cellIdx] = (st.cur.cells[st.cellIdx] ?? "") + ch
}

const closeRow = (st: TokenizerState): void => {
  st.rows.push(st.cur)
  st.cur = { cells: [""], lineNumber: st.line + 1 }
  st.cellIdx = 0
}

/** Quoted-state handler: process one char while inside a `"…"` cell. */
const stepQuoted = (st: TokenizerState, source: string, i: number, ch: string): void => {
  if (ch === '"') {
    // Look-ahead for escaped quote `""`.
    if (source[i + 1] === '"') {
      appendChar(st, '"')
      st.skipNext = true
    } else {
      st.quoted = false
    }
    return
  }
  if (ch === "\n") {
    // Embedded newline inside quoted cell — preserve verbatim, advance line.
    appendChar(st, ch)
    st.line++
    return
  }
  appendChar(st, ch)
}

/** Field-state handler: process one char while outside any quoted cell. */
const stepField = (
  st: TokenizerState,
  source: string,
  i: number,
  ch: string,
  delimiter: string,
): void => {
  if (ch === '"' && (st.cur.cells[st.cellIdx] ?? "") === "") {
    st.quoted = true
    st.openQuoteLine = st.line
    return
  }
  if (ch === delimiter) {
    st.cellIdx++
    st.cur.cells.push("")
    return
  }
  if (ch === "\r") {
    // CRLF — swallow the LF that follows; bare CR is treated as a line break.
    if (source[i + 1] === "\n") st.skipNext = true
    closeRow(st)
    st.line++
    return
  }
  if (ch === "\n") {
    closeRow(st)
    st.line++
    return
  }
  appendChar(st, ch)
}

/** RFC-4180 quote-aware split — returns the rows as `string[][]` plus
 *  per-row source line numbers and any unterminated-quote diagnostics. */
const tokenize = (
  source: string,
  delimiter: string,
): { rows: RowBuf[]; diagnostics: CsvParseDiagnostic[] } => {
  const st: TokenizerState = {
    rows: [],
    cur: { cells: [""], lineNumber: 1 },
    cellIdx: 0,
    line: 1,
    skipNext: false,
    quoted: false,
    openQuoteLine: 0,
  }

  for (let i = 0; i < source.length; i++) {
    const ch = source[i] ?? ""
    st.skipNext = false
    if (st.quoted) {
      stepQuoted(st, source, i, ch)
    } else {
      stepField(st, source, i, ch, delimiter)
    }
    if (st.skipNext) i++
  }

  // Flush the final row if anything is buffered. A trailing newline yields
  // a fresh empty row buffer; we treat a single-empty-cell row at EOF as
  // a non-row (matches `String.split("\n")` semantics for trailing `\n`).
  const lastCell = st.cur.cells[st.cellIdx] ?? ""
  const hasContent = st.cur.cells.length > 1 || lastCell !== ""
  if (hasContent) {
    st.rows.push(st.cur)
  }

  const diagnostics: CsvParseDiagnostic[] = []
  if (st.quoted) {
    diagnostics.push({
      kind: "unterminated-quote",
      line: st.openQuoteLine,
      message: `unterminated quoted cell starting at line ${st.openQuoteLine}`,
    })
  }
  return { rows: st.rows, diagnostics }
}

/** Build the empty-result shape used both for empty input AND for a non-empty
 *  input that tokenized to zero rows. The seed diagnostics from the tokenizer
 *  (if any) are prefixed; the `empty-input` diagnostic always closes. */
const emptyResult = (seed: ReadonlyArray<CsvParseDiagnostic>, message: string): CsvParseResult =>
  Object.freeze({
    headers: null,
    rows: Object.freeze([]),
    diagnostics: Object.freeze([...seed, { kind: "empty-input" as const, line: 1, message }]),
  })

/** Assemble the final data rows + ragged-row diagnostics. Pure. */
const assembleRows = (
  rawRows: ReadonlyArray<RowBuf>,
  dataStart: number,
  expectedCols: number,
): { rows: CsvRow[]; raggedDiagnostics: CsvParseDiagnostic[] } => {
  const rows: CsvRow[] = []
  const raggedDiagnostics: CsvParseDiagnostic[] = []
  for (let r = dataStart; r < rawRows.length; r++) {
    const rb = rawRows[r]
    if (!rb) continue
    if (rb.cells.length !== expectedCols) {
      raggedDiagnostics.push({
        kind: "ragged-row",
        line: rb.lineNumber,
        message: `ragged row at line ${rb.lineNumber}: ${rb.cells.length} cells (expected ${expectedCols})`,
      })
    }
    rows.push(freezeRow(rb))
  }
  return { rows, raggedDiagnostics }
}

/** Parse a CSV / TSV string into typed rows + diagnostics.
 *
 *  Pure. Never throws on malformed input (only on a non-string argument —
 *  see {@link CsvParserInputError}). */
export const parseCsv = (source: string, opts: CsvParseOpts = {}): CsvParseResult => {
  if (typeof source !== "string") {
    throw new CsvParserInputError(
      `parseCsv expects a string, got ${source === null ? "null" : typeof source}`,
    )
  }
  const rawDelim = opts.delimiter ?? ","
  // Defensive: a multi-char delimiter is collapsed to its first char. Empty
  // string falls back to "," — never throws.
  const delimiter = rawDelim.length === 0 ? "," : (rawDelim[0] ?? ",")
  const noHeader = opts.noHeader === true

  if (source.length === 0) {
    return emptyResult([], "empty input — no rows parsed")
  }

  const { rows: rawRows, diagnostics } = tokenize(source, delimiter)
  if (rawRows.length === 0) {
    return emptyResult(diagnostics, "no rows after tokenization")
  }

  let headers: ReadonlyArray<string> | null = null
  let dataStart = 0
  if (!noHeader) {
    const headerRow = rawRows[0]
    if (headerRow) {
      headers = Object.freeze(headerRow.cells.slice())
      dataStart = 1
    }
  }

  const expectedCols = headers !== null ? headers.length : (rawRows[0]?.cells.length ?? 0)
  const { rows, raggedDiagnostics } = assembleRows(rawRows, dataStart, expectedCols)

  return Object.freeze({
    headers,
    rows: Object.freeze(rows),
    diagnostics: Object.freeze([...diagnostics, ...raggedDiagnostics]),
  })
}
