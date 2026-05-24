/**
 * csv-parse-backed CSV/TSV parser (ADR-0177 — SOTA swap).
 *
 * # Why this exists
 *
 * Sibling `./csv-parse.ts` is a ~280 LOC hand-rolled RFC-4180 tokenizer. It
 * works, but the user principle is explicit: **"외부에 잘 만들어진 거 있으면
 * 외부 거 써."** `csv-parse@6.x` (Adaltas, maintained since 2010, 5M+ weekly
 * downloads) is the canonical Node CSV parser; it covers the same RFC-4180
 * surface plus byte-order marks, comments, casting, streaming, etc. We adopt
 * it via a thin adapter that PRESERVES the public {@link CsvParseResult}
 * shape so callers (notably `csv_read`) see no behavioral drift.
 *
 * # Contract
 *
 * Same as {@link import("./csv-parse").parseCsv}:
 *  1. Pure — no I/O, input is a `string`, output is the typed result.
 *  2. No-throw on malformed input — `CsvError` from the lib is mapped to a
 *     typed {@link CsvParseDiagnostic}. The function only throws when the
 *     INPUT is not a string (programmer bug, mirrored to
 *     {@link CsvParserInputError}).
 *  3. exactOptionalPropertyTypes — optional `column` on the diagnostic is
 *     OMITTED when absent, never set to `undefined`.
 *
 * # Behavioral parity with the self-impl
 *
 * The lib has its own opinions; we tune the options to match `parseCsv`:
 *  - `columns: false` — we receive `string[][]`, then peel off the header row
 *    ourselves when `noHeader` is false. This preserves COLUMN ORDER (object
 *    keys would scramble it) AND keeps the cell-with-index shape.
 *  - `relax_column_count: true` — ragged rows pass through; we synthesize the
 *    `ragged-row` diagnostic from the parsed row lengths (lib reports the
 *    count via `info.invalid_field_length` but does NOT pinpoint which rows).
 *  - `relax_quotes: true` — degrades quote violations to best-effort instead
 *    of throwing. We still TRY to surface a diagnostic when the lib throws.
 *  - `raw: true, info: true` — every record carries its original source text
 *    AND start metadata, which lets us reconstruct 1-indexed start-line
 *    numbers (the self-impl semantic) by counting newlines in preceding raws.
 *  - `skip_empty_lines: false, trim: false, bom: false` — verbatim cells.
 *
 * # Diagnostic mapping
 *
 *  - `CSV_QUOTE_NOT_CLOSED`              → `kind: "unterminated-quote"`
 *  - `CSV_RECORD_INCONSISTENT_FIELDS_LENGTH` → `kind: "ragged-row"` (also
 *    derived row-by-row from cell-count comparison since the lib does not
 *    pinpoint each ragged row when `relax_column_count` is on).
 *  - empty input                          → `kind: "empty-input"`
 *  - any other `CsvError`                 → `kind: "unterminated-quote"`
 *    (the only other surface we can encounter with our tuning; the alternative
 *    would be widening the closed union, which we explicitly avoid).
 *
 * # NOT a drop-in for self-impl SEMANTICS in every corner
 *
 * We aim for the SAME public shape (`CsvParseResult`) — not for byte-equal
 * row counts in extreme corners (e.g. a single-cell partial row recovered
 * after EOF in mid-quote). The hellgate at
 * `tests/unit/csv-parse-lib-hellgate.test.ts` documents which corners we
 * assert byte-equal and which corners we only assert SHAPE-equal.
 */

import { parse } from "csv-parse/sync"
import {
  type CsvParseDiagnostic,
  type CsvParseOpts,
  type CsvParseResult,
  CsvParserInputError,
  type CsvRow,
} from "./csv-parse"

// Re-export the lib-flavored diagnostic shape error class for symmetry — the
// underlying type comes from the sibling.
export { CsvParserInputError } from "./csv-parse"

interface RawRecord {
  readonly record: string[]
  readonly raw?: string
  readonly info?: { readonly lines?: number }
}

/** Resolve the effective single-char delimiter the same way {@link parseCsv}
 *  does (empty string ⇒ `,`, multi-char ⇒ first char). Keeping this logic
 *  here — not delegating to the sibling — preserves the "zero-dep on the
 *  self-impl runtime" posture so a future delete of the self-impl is a
 *  trivial mechanical step. */
const resolveDelimiter = (raw: string | undefined): string => {
  if (raw === undefined) return ","
  if (raw.length === 0) return ","
  return raw[0] ?? ","
}

/** Per-row diagnostic synthesis for ragged-row. The lib only counts ragged
 *  rows via `info.invalid_field_length`; it does NOT emit per-row pointers
 *  when `relax_column_count` is on. We re-derive the per-row diagnostics by
 *  comparing each row's `cells.length` to `expectedCols` — same algorithm as
 *  the self-impl's `assembleRows`. */
const synthesizeRaggedDiagnostics = (
  rows: ReadonlyArray<CsvRow>,
  expectedCols: number,
): CsvParseDiagnostic[] => {
  const out: CsvParseDiagnostic[] = []
  for (const r of rows) {
    if (r.cells.length !== expectedCols) {
      out.push({
        kind: "ragged-row",
        line: r.lineNumber,
        message: `ragged row at line ${r.lineNumber}: ${r.cells.length} cells (expected ${expectedCols})`,
      })
    }
  }
  return out
}

/** Translate a `CsvError` thrown by the lib into our typed diagnostic. We
 *  only encounter throws when `relax_quotes: true` is not enough — primarily
 *  `CSV_QUOTE_NOT_CLOSED`. The CsvError message includes "line N" which we
 *  parse out as a best-effort line pointer (falls back to 1). */
const csvErrorToDiagnostic = (err: unknown): CsvParseDiagnostic => {
  const message = err instanceof Error ? err.message : String(err)
  const code = (err as { code?: unknown }).code
  const lineMatch = /line (\d+)/.exec(message)
  const line = lineMatch?.[1] ? Number.parseInt(lineMatch[1], 10) : 1
  if (code === "CSV_QUOTE_NOT_CLOSED" || code === "INVALID_OPENING_QUOTE") {
    return {
      kind: "unterminated-quote",
      line,
      message: `unterminated quoted cell starting at line ${line}`,
    }
  }
  // Any other CsvError we encounter with our tuning is degraded to the
  // unterminated-quote kind to keep the closed union closed. We DO NOT
  // widen the union here — that requires an ADR + every consumer's switch
  // updated. The message preserves the lib's original text for visibility.
  return { kind: "unterminated-quote", line, message }
}

/** Build the empty-result shape used both for empty input AND for input that
 *  parsed to zero rows. Mirrors self-impl `emptyResult`. */
const emptyResult = (seed: ReadonlyArray<CsvParseDiagnostic>, message: string): CsvParseResult =>
  Object.freeze({
    headers: null,
    rows: Object.freeze([]),
    diagnostics: Object.freeze([...seed, { kind: "empty-input" as const, line: 1, message }]),
  })

/** Convert a single lib record (with raw + info) into our typed row.
 *  `lineNumber` is computed by the caller (cumulative newline count) so this
 *  helper stays pure of any threading state. */
const freezeRow = (cells: ReadonlyArray<string>, lineNumber: number): CsvRow =>
  Object.freeze({
    cells: cells.map((raw, i) => Object.freeze({ raw, column: i + 1 })),
    lineNumber,
  })

/** csv-parse-backed CSV parser. Same public shape (CsvParseResult) as the
 *  self-implemented version in `./csv-parse.ts`. */
export const parseCsvLib = (source: string, opts: CsvParseOpts = {}): CsvParseResult => {
  if (typeof source !== "string") {
    throw new CsvParserInputError(
      `parseCsvLib expects a string, got ${source === null ? "null" : typeof source}`,
    )
  }

  const delimiter = resolveDelimiter(opts.delimiter)
  const noHeader = opts.noHeader === true

  if (source.length === 0) {
    return emptyResult([], "empty input — no rows parsed")
  }

  let records: RawRecord[]
  const seedDiagnostics: CsvParseDiagnostic[] = []
  try {
    // csv-parse sync overloads do not surface the `{ record, raw, info }`
    // shape we receive when both `raw: true` and `info: true` are set. We
    // cast at the boundary via `as never` (no `any` introduced) and
    // immediately narrow into the typed `RawRecord[]`.
    records = parse(source, {
      delimiter,
      columns: false,
      relax_column_count: true,
      relax_quotes: true,
      raw: true,
      info: true,
      bom: false,
      skip_empty_lines: false,
      trim: false,
    } as never) as unknown as RawRecord[]
  } catch (err) {
    seedDiagnostics.push(csvErrorToDiagnostic(err))
    // Best-effort recovery: re-parse with the same tuning minus `raw/info`
    // and accept whatever the lib could surface. If even that throws, give
    // up and return an empty result with the diagnostic seeded.
    try {
      const fallback = parse(source, {
        delimiter,
        columns: false,
        relax_column_count: true,
        relax_quotes: true,
        bom: false,
        skip_empty_lines: false,
        trim: false,
      }) as string[][]
      records = fallback.map((record) => ({ record }))
    } catch {
      return emptyResult(seedDiagnostics, "no rows after tokenization")
    }
  }

  if (records.length === 0) {
    return emptyResult(seedDiagnostics, "no rows after tokenization")
  }

  // Reconstruct 1-indexed START-line numbers from the lib's END-line metadata.
  //   `info.lines` is the END line of the record (1-indexed). For records
  //   without embedded newlines, START == END. For records with embedded
  //   newlines inside a quoted cell, START < END.
  //
  //   The relationship between consecutive records is invariant: a record's
  //   START line is the PREVIOUS record's END line + 1 (the line right after
  //   the previous record's terminator). The first record always starts at
  //   line 1.
  //
  //   Counting `\n` inside the captured `raw` is unreliable because the lib
  //   STRIPS the trailing line terminator for CRLF input (raw contains `\r`
  //   but not `\n`). Hence the info.lines-based reconstruction.
  const lineNumbers: number[] = []
  let prevEnd = 0
  for (const rec of records) {
    const start = prevEnd + 1
    lineNumbers.push(start)
    const end = typeof rec.info?.lines === "number" ? rec.info.lines : start
    prevEnd = end
  }

  let headers: ReadonlyArray<string> | null = null
  let dataStart = 0
  if (!noHeader) {
    const headerRec = records[0]
    if (headerRec) {
      headers = Object.freeze(headerRec.record.slice())
      dataStart = 1
    }
  }

  const expectedCols = headers !== null ? headers.length : (records[0]?.record.length ?? 0)

  const rows: CsvRow[] = []
  for (let r = dataStart; r < records.length; r++) {
    const rec = records[r]
    if (!rec) continue
    rows.push(freezeRow(rec.record, lineNumbers[r] ?? 1))
  }

  const raggedDiagnostics = synthesizeRaggedDiagnostics(rows, expectedCols)
  return Object.freeze({
    headers,
    rows: Object.freeze(rows),
    diagnostics: Object.freeze([...seedDiagnostics, ...raggedDiagnostics]),
  })
}
