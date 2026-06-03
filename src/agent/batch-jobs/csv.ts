/**
 * Batch-jobs slice — CSV parse + export (ADR-0463).
 *
 * Reuses the mature `csv-parse` lib already vendored in the repo (the same lib
 * `@/tool/document` family standardised on) for the parse side. We do NOT
 * hand-roll CSV. Export is a small RFC-4180 quote-emitter (no separate
 * `csv-stringify` dep is vendored, so this minimal writer is the documented
 * trade-off — it only quotes when needed and escapes `"` → `""`).
 *
 * SLICE: imports only `csv-parse/sync` (a vendored dep) + this slice's types.
 * No `@/storage`, no FS — input is a string, output is a string. The caller
 * reads/writes the file at the composition root.
 *
 * Contract:
 *   - NO-THROW: parse failures resolve `Err`, never throw past the boundary.
 *   - DEFAULT-OFF: pure functions; calling them has no side effects.
 */

import { parse } from "csv-parse/sync"
import { err, ok, type Result } from "@/shared"
import type { BatchJobError, JobRow } from "./types"

export interface ParsedCsv {
  readonly headers: ReadonlyArray<string>
  readonly rows: ReadonlyArray<JobRow>
}

/**
 * Parse a CSV string into headers + header→value row maps via `csv-parse`.
 *
 * Empty input (or header-only input) yields zero rows + the parsed headers
 * (empty array when there is no header line) — NOT an error. A genuinely
 * malformed CSV (e.g. unterminated quote) resolves `Err({kind:"invalid-spec"})`
 * because the `csv-parse` lib throws on those; we catch + convert.
 */
export const parseRowsFromCsv = (source: string): Result<ParsedCsv, BatchJobError> => {
  if (typeof source !== "string") {
    return err<BatchJobError>({ kind: "invalid-spec", reason: "csv source must be a string" })
  }
  if (source.length === 0) {
    return ok({ headers: [], rows: [] })
  }
  try {
    // `columns: true` ⇒ first record is the header row; each subsequent record
    // is a header→value map. `relax_column_count: false` keeps ragged rows a
    // hard error (the caller wants to know the CSV is malformed).
    const records = parse(source, {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: false,
    }) as Array<Record<string, string>>

    // Recover the header order: `columns: true` gives objects whose key order
    // follows the header line, so the first record's keys ARE the headers. When
    // there are zero data rows we re-parse the first line as raw to recover
    // headers deterministically.
    if (records.length === 0) {
      const firstLine = source.split(/\r?\n/, 1)[0] ?? ""
      const headerOnly = parse(firstLine, { columns: false }) as string[][]
      const headers = headerOnly[0] ?? []
      return ok({ headers: Object.freeze(headers.slice()), rows: [] })
    }

    const first = records[0]
    const headers = first ? Object.keys(first) : []
    const rows = records.map((r) => Object.freeze({ ...r }))
    return ok({ headers: Object.freeze(headers.slice()), rows: Object.freeze(rows) })
  } catch (e) {
    return err<BatchJobError>({
      kind: "invalid-spec",
      reason: `malformed CSV: ${e instanceof Error ? e.message : String(e)}`,
    })
  }
}

/** RFC-4180 cell quoting: wrap in `"…"` and double inner quotes only when the
 *  cell contains a delimiter, quote, CR, or LF. */
const quoteCell = (raw: string): string =>
  /[",\r\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw

/**
 * Render a results CSV. Columns: the input headers (preserving row data) +
 * trailing result columns the caller passes (e.g. `status`, `result`,
 * `error`). The row maps are looked up by header; a missing key yields an empty
 * cell (never throws). Deterministic column order = `headers` then
 * `extraColumns`.
 */
export const renderResultsCsv = (
  headers: ReadonlyArray<string>,
  extraColumns: ReadonlyArray<string>,
  rows: ReadonlyArray<Readonly<Record<string, string>>>,
): string => {
  const allColumns = [...headers, ...extraColumns]
  const lines: string[] = []
  lines.push(allColumns.map(quoteCell).join(","))
  for (const row of rows) {
    lines.push(allColumns.map((col) => quoteCell(row[col] ?? "")).join(","))
  }
  // Trailing newline matches `csv-stringify`'s default + most spreadsheet
  // importers' expectation.
  return `${lines.join("\n")}\n`
}
