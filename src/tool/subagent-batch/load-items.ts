/**
 * RFC-02 §5.2 — item loading. Inline array OR a `.csv` / `.jsonl` / `.json`
 * file (read through the injected {@link ReadFilePort} — the slice never touches
 * `node:fs`). All parsers are inlined (dependency-free, ADR-0205 frontmatter
 * precedent). NO-THROW: every failure returns `{ok:false, error}`, never throws.
 */

import { errMessage } from "@/shared"
import type { ReadFilePort } from "./port"
import type { BatchItem } from "./template"

export type LoadResult =
  | { readonly ok: true; readonly items: readonly BatchItem[] }
  | { readonly ok: false; readonly error: string }

/** Pick the file shape from the extension (case-insensitive). */
const extOf = (path: string): "csv" | "jsonl" | "json" | "unknown" => {
  const lower = path.toLowerCase()
  if (lower.endsWith(".csv")) return "csv"
  if (lower.endsWith(".jsonl")) return "jsonl"
  if (lower.endsWith(".json")) return "json"
  return "unknown"
}

/**
 * Minimal RFC4180-ish CSV line splitter. Handles:
 *   - comma field separator
 *   - double-quoted fields (commas + newlines inside quotes are literal)
 *   - escaped quote `""` inside a quoted field ⇒ a single `"`.
 * Returns the full table as rows of cells. Pure.
 */
interface CsvState {
  rows: string[][]
  row: string[]
  cell: string
  inQuotes: boolean
  i: number
}

/** Step one char while INSIDE a quoted field. Returns the advance count. */
const stepQuoted = (st: CsvState, text: string, ch: string): number => {
  if (ch === '"') {
    if (text[st.i + 1] === '"') {
      st.cell += '"'
      return 2
    }
    st.inQuotes = false
    return 1
  }
  st.cell += ch
  return 1
}

/** Step one char while OUTSIDE quotes. Returns the advance count. */
const stepUnquoted = (st: CsvState, text: string, ch: string): number => {
  if (ch === '"') {
    st.inQuotes = true
    return 1
  }
  if (ch === ",") {
    st.row.push(st.cell)
    st.cell = ""
    return 1
  }
  if (ch === "\n") {
    endCsvRow(st)
    return 1
  }
  if (ch === "\r") {
    endCsvRow(st)
    return text[st.i + 1] === "\n" ? 2 : 1
  }
  st.cell += ch
  return 1
}

const endCsvRow = (st: CsvState): void => {
  st.row.push(st.cell)
  st.cell = ""
  st.rows.push(st.row)
  st.row = []
}

const parseCsvCells = (text: string): string[][] => {
  const st: CsvState = { rows: [], row: [], cell: "", inQuotes: false, i: 0 }
  while (st.i < text.length) {
    const ch = text[st.i] as string
    st.i += st.inQuotes ? stepQuoted(st, text, ch) : stepUnquoted(st, text, ch)
  }
  // Flush a trailing cell/row unless the input ended exactly on a newline.
  if (st.cell.length > 0 || st.row.length > 0) endCsvRow(st)
  return st.rows
}

/** Parse CSV text into object items keyed by the header row. */
const parseCsv = (text: string): LoadResult => {
  const cells = parseCsvCells(text).filter((r) => !(r.length === 1 && r[0] === ""))
  if (cells.length === 0) return { ok: false, error: "csv requires a header row" }
  const header = cells[0]
  if (header === undefined || header.length === 0 || header.every((h) => h === "")) {
    return { ok: false, error: "csv requires a header row" }
  }
  const items: BatchItem[] = []
  for (let r = 1; r < cells.length; r++) {
    const cols = cells[r] as string[]
    const obj: Record<string, unknown> = {}
    for (let c = 0; c < header.length; c++) {
      obj[header[c] as string] = cols[c] ?? ""
    }
    items.push(obj)
  }
  return { ok: true, items }
}

/** Parse JSONL — one JSON value per non-blank line. */
const parseJsonl = (text: string): LoadResult => {
  const items: BatchItem[] = []
  const lines = text.split("\n")
  for (let n = 0; n < lines.length; n++) {
    const line = (lines[n] as string).trim()
    if (line === "") continue
    try {
      items.push(JSON.parse(line) as BatchItem)
    } catch {
      return { ok: false, error: `jsonl parse error on line ${n + 1}` }
    }
  }
  return { ok: true, items }
}

/** Parse a JSON array file. */
const parseJsonArray = (text: string): LoadResult => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, error: "json file is not valid JSON" }
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, error: "json file must contain a top-level array" }
  }
  return { ok: true, items: parsed as BatchItem[] }
}

/**
 * Load items from either an inline array or a file path. Exactly one of
 * `items` / `items_path` must be present (validated upstream too, but checked
 * here for safety). Returns `{ok:false}` rather than throwing.
 */
export const loadItems = async (
  args: { items?: readonly BatchItem[]; items_path?: string },
  readFile: ReadFilePort | undefined,
): Promise<LoadResult> => {
  const hasInline = args.items !== undefined
  const hasPath = args.items_path !== undefined && args.items_path !== ""
  if (hasInline === hasPath) {
    return { ok: false, error: "provide exactly one of items / items_path" }
  }
  if (hasInline) {
    return { ok: true, items: args.items as readonly BatchItem[] }
  }
  // file path branch
  if (readFile === undefined) {
    return { ok: false, error: "items_path was supplied but no file reader is wired" }
  }
  const path = args.items_path as string
  const kind = extOf(path)
  if (kind === "unknown") {
    return {
      ok: false,
      error: `unsupported items_path extension (need .csv/.jsonl/.json): ${path}`,
    }
  }
  let text: string
  try {
    text = await readFile(path)
  } catch (e) {
    return { ok: false, error: `failed to read items_path: ${errMessage(e)}` }
  }
  if (kind === "csv") return parseCsv(text)
  if (kind === "jsonl") return parseJsonl(text)
  return parseJsonArray(text)
}
