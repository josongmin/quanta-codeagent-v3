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

/** RFC-4180 quote-aware split — returns the rows as `string[][]` plus
 *  per-row source line numbers and any unterminated-quote diagnostics. */
const tokenize = (
  source: string,
  delimiter: string,
): { rows: RowBuf[]; diagnostics: CsvParseDiagnostic[] } => {
  const rows: RowBuf[] = []
  const diagnostics: CsvParseDiagnostic[] = []
  let cur: RowBuf = { cells: [""], lineNumber: 1 }
  let cellIdx = 0
  let line = 1
  let quoted = false
  let openQuoteLine = 0

  const pushCell = (): void => {
    cellIdx++
    cur.cells.push("")
  }

  const pushRow = (): void => {
    rows.push(cur)
    cur = { cells: [""], lineNumber: line }
    cellIdx = 0
  }

  for (let i = 0; i < source.length; i++) {
    const ch = source[i] ?? ""
    if (quoted) {
      if (ch === '"') {
        // Look-ahead for escaped quote `""`.
        if (source[i + 1] === '"') {
          cur.cells[cellIdx] = (cur.cells[cellIdx] ?? "") + '"'
          i++
        } else {
          quoted = false
        }
        continue
      }
      // Embedded newline inside quoted cell — preserve verbatim, advance line.
      if (ch === "\n") {
        cur.cells[cellIdx] = (cur.cells[cellIdx] ?? "") + ch
        line++
        continue
      }
      cur.cells[cellIdx] = (cur.cells[cellIdx] ?? "") + ch
      continue
    }
    // Not in a quoted cell.
    if (ch === '"' && (cur.cells[cellIdx] ?? "") === "") {
      quoted = true
      openQuoteLine = line
      continue
    }
    if (ch === delimiter) {
      pushCell()
      continue
    }
    if (ch === "\r") {
      // CRLF — swallow the LF that follows; bare CR is treated as a line break.
      if (source[i + 1] === "\n") i++
      pushRow()
      line++
      continue
    }
    if (ch === "\n") {
      pushRow()
      line++
      continue
    }
    cur.cells[cellIdx] = (cur.cells[cellIdx] ?? "") + ch
  }

  // Flush the final row if anything is buffered. A trailing newline yields
  // a fresh empty row buffer; we treat a single-empty-cell row at EOF as
  // a non-row (matches `String.split("\n")` semantics for trailing `\n`).
  const lastCell = cur.cells[cellIdx] ?? ""
  const hasContent = cur.cells.length > 1 || lastCell !== ""
  if (hasContent) {
    rows.push(cur)
  }

  if (quoted) {
    diagnostics.push({
      kind: "unterminated-quote",
      line: openQuoteLine,
      message: `unterminated quoted cell starting at line ${openQuoteLine}`,
    })
  }
  return { rows, diagnostics }
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
    return Object.freeze({
      headers: null,
      rows: Object.freeze([]),
      diagnostics: Object.freeze([
        {
          kind: "empty-input" as const,
          line: 1,
          message: "empty input — no rows parsed",
        },
      ]),
    })
  }

  const { rows: rawRows, diagnostics } = tokenize(source, delimiter)

  if (rawRows.length === 0) {
    return Object.freeze({
      headers: null,
      rows: Object.freeze([]),
      diagnostics: Object.freeze([
        ...diagnostics,
        {
          kind: "empty-input" as const,
          line: 1,
          message: "no rows after tokenization",
        },
      ]),
    })
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

  const expectedCols =
    headers !== null ? headers.length : (rawRows[0]?.cells.length ?? 0)

  const rows: CsvRow[] = []
  const allDiagnostics: CsvParseDiagnostic[] = [...diagnostics]

  for (let r = dataStart; r < rawRows.length; r++) {
    const rb = rawRows[r]
    if (!rb) continue
    if (rb.cells.length !== expectedCols) {
      allDiagnostics.push({
        kind: "ragged-row",
        line: rb.lineNumber,
        message: `ragged row at line ${rb.lineNumber}: ${rb.cells.length} cells (expected ${expectedCols})`,
      })
    }
    rows.push(freezeRow(rb))
  }

  return Object.freeze({
    headers,
    rows: Object.freeze(rows),
    diagnostics: Object.freeze(allDiagnostics),
  })
}
