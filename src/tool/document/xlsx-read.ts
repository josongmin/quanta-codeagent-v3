/**
 * `xlsx_read` tool (ADR-0137 Part 3 / ADR-0138) — REAL reader.
 *
 * jun-04: the "deps decision deferred to ADR-0138" stub is RESOLVED with a
 * pure-TS reader (NO dependency): `node:zlib.inflateRawSync` (via the authoring
 * slice's {@link unzip}) handles DEFLATE entries, and a focused OOXML parser
 * resolves cells. Reads BOTH STORED (quanta's own `xlsx_write` output) and
 * DEFLATE (real-world Excel) workbooks — closing the H14b round-trip
 * (`xlsx_write` → disk → `xlsx_read` returns the cells).
 *
 * Two layers:
 *   - {@link parseXlsx}: PURE `bytes → {sheets}` (no FS) — the testable core.
 *   - {@link xlsxReadTool}: the FS-jailed tool wrapper (mirrors `csv-read.ts`).
 */

import { lstat, readFile } from "node:fs/promises"
import { z } from "zod"
import { errMessage } from "@/shared"
import { FsJailError } from "@/storage"
import { resolveJailedDoc } from "../_shared/resolve-jailed-doc"
import type { Tool, ToolContext, ToolEvent, ToolResult } from "../types"
import { findZipPart, unzip } from "./authoring/zip-store"

const MAX_XLSX_BYTES = 32 * 1024 * 1024
const DEFAULT_MAX_ROWS = 100

export const xlsxReadInputSchema = z.object({
  path: z.string().min(1).describe("Repo-relative or absolute path to the XLSX file"),
  sheet: z.string().optional().describe("Sheet name to read (default: first sheet)."),
  maxRows: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`Max rows to render (default ${DEFAULT_MAX_ROWS}).`),
})
export type XlsxReadInput = z.infer<typeof xlsxReadInputSchema>

// ── pure OOXML parse ─────────────────────────────────────────────────────────

/** One parsed worksheet: a name + a row-major string grid behind {@link cellAt}. */
export interface XlsxSheet {
  readonly name: string
  readonly rowCount: number
  /** Cell value (always a string; numbers are stringified, empty cells `""`). */
  cellAt(row: number, col: number): string
}

export type ParseXlsxResult =
  | { readonly ok: true; readonly sheets: XlsxSheet[] }
  | { readonly ok: false; readonly error: string }

/** Reverse the 5 XML entities + numeric char refs. Pure. */
const unescapeXml = (s: string): string =>
  s
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number.parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

/** Concatenate every unprefixed `<t>…</t>` inside a fragment (rich-text runs). */
const collectText = (fragment: string): string => {
  let out = ""
  const re = /<t[^>]*>([\s\S]*?)<\/t>/g
  for (let m = re.exec(fragment); m !== null; m = re.exec(fragment)) out += unescapeXml(m[1] ?? "")
  return out
}

const parseSharedStrings = (xml: string | undefined): string[] => {
  if (xml === undefined) return []
  const pool: string[] = []
  const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g
  for (let m = re.exec(xml); m !== null; m = re.exec(xml)) pool.push(collectText(m[1] ?? ""))
  return pool
}

/** Excel's hard column ceiling is XFD = column 16384 (0-based 16383). A cell ref
 *  with MORE letters than that is invalid SpreadsheetML; a hostile workbook can
 *  smuggle e.g. `r="ZZZZZZ1"` (column ~321 million) in a few bytes, which — when
 *  used to size a positional row array — forces an unbounded `push` loop (OOM /
 *  multi-second hang from one tiny cell). We cap the resolved index so an
 *  out-of-range ref can never drive an allocation past Excel's own grid. */
export const XLSX_MAX_COL_INDEX = 16383

/** A1 cell ref → 0-based column index (`A`→0, `AA`→26). Letters beyond Excel's
 *  XFD ceiling are clamped to {@link XLSX_MAX_COL_INDEX} so a malicious mega-ref
 *  cannot drive an unbounded allocation (resource-DoS guard). */
const colIndexOf = (ref: string): number => {
  const letters = ref.replace(/[0-9]+$/, "")
  // Beyond 3 letters the column already exceeds XFD; clamp early WITHOUT
  // accumulating the (potentially astronomical) value to avoid the work itself.
  if (letters.length > 3) return XLSX_MAX_COL_INDEX
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  const idx = n - 1
  return idx > XLSX_MAX_COL_INDEX ? XLSX_MAX_COL_INDEX : idx
}

const rawV = (cellInner: string): string => /<v>([\s\S]*?)<\/v>/.exec(cellInner)?.[1] ?? ""

const cellValue = (cellInner: string, attrs: string, shared: string[]): string => {
  const t = /\bt="([^"]*)"/.exec(attrs)?.[1]
  if (t === "s") {
    const idx = Number.parseInt(rawV(cellInner), 10)
    return Number.isFinite(idx) ? (shared[idx] ?? "") : ""
  }
  if (t === "inlineStr") return collectText(cellInner)
  return unescapeXml(rawV(cellInner))
}

/** Parse one `<row>` body into its (positionally-placed) cell values. */
const parseRowCells = (body: string, shared: string[]): string[] => {
  const cells: string[] = []
  // The open-tag alternative's `(?<!\/)>` is LOAD-BEARING: a self-closing empty
  // cell `<c r="A1" s="1"/>` (Excel emits these for styled-but-empty cells)
  // would otherwise be SWALLOWED by the greedy `[^>]*` of the first alternative,
  // which anchors on the NEXT cell's `>` — placing the following value cell's
  // content at the WRONG column (silent one-column left-shift of the whole row).
  // The negative lookbehind forbids the paired-tag alternative from matching a
  // `/>`, forcing the self-closing alternative to claim it instead.
  const cellRe = /<c\b([^>]*)(?<!\/)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g
  for (let cm = cellRe.exec(body); cm !== null; cm = cellRe.exec(body)) {
    const attrs = cm[1] ?? cm[3] ?? ""
    const inner = cm[2] ?? ""
    const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1]
    const col = ref !== undefined ? colIndexOf(ref) : cells.length
    while (cells.length <= col) cells.push("")
    cells[col] = inner === "" ? "" : cellValue(inner, attrs, shared)
  }
  return cells
}

/** Parse a worksheet XML into a row-major grid (ragged rows padded). */
const parseGrid = (xml: string, shared: string[]): string[][] => {
  const rows: string[][] = []
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g
  let maxCol = 0
  for (let rm = rowRe.exec(xml); rm !== null; rm = rowRe.exec(xml)) {
    const cells = parseRowCells(rm[1] ?? "", shared)
    if (cells.length > maxCol) maxCol = cells.length
    rows.push(cells)
  }
  for (const r of rows) while (r.length < maxCol) r.push("")
  return rows
}

const parseSheetNames = (xml: string): string[] => {
  const names: string[] = []
  const re = /<sheet\b[^>]*\bname="([^"]*)"/g
  for (let m = re.exec(xml); m !== null; m = re.exec(xml)) names.push(unescapeXml(m[1] ?? ""))
  return names
}

/** Numeric index of `xl/worksheets/sheetN.xml` (`N`). Deterministic (locale-
 *  independent) ordering — avoids `localeCompare`, which the no-sketchy-code
 *  scanner forbids for its locale-dependence. */
const sheetPartIndex = (path: string): number => {
  const n = /sheet(\d+)\.xml$/.exec(path)?.[1]
  return n !== undefined ? Number.parseInt(n, 10) : Number.MAX_SAFE_INTEGER
}

const makeSheet = (name: string, grid: string[][]): XlsxSheet => ({
  name,
  rowCount: grid.length,
  cellAt: (row, col) => grid[row]?.[col] ?? "",
})

/**
 * Parse `.xlsx` bytes into sheets. No-throw: malformed input → `{ok:false}`.
 * Requires `xl/workbook.xml` (the authoritative sheet index); `xl/sharedStrings.xml`
 * is optional (string refs resolve to `""` when absent or out-of-range).
 */
export const parseXlsx = (bytes: Uint8Array): ParseXlsxResult => {
  const zip = unzip(bytes)
  if (!zip.ok) return { ok: false, error: `not a valid xlsx (zip): ${zip.error}` }
  const wbBytes = findZipPart(zip, "xl/workbook.xml")
  if (wbBytes === undefined) return { ok: false, error: "xlsx: missing xl/workbook.xml" }
  const ssBytes = findZipPart(zip, "xl/sharedStrings.xml")
  const shared = parseSharedStrings(ssBytes === undefined ? undefined : decode(ssBytes))
  const names = parseSheetNames(decode(wbBytes))
  const orderedParts = zip.entries
    .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.path))
    .sort((a, b) => sheetPartIndex(a.path) - sheetPartIndex(b.path))
  const sheets: XlsxSheet[] = []
  const count = Math.max(names.length, orderedParts.length)
  for (let i = 0; i < count; i++) {
    const part = findZipPart(zip, `xl/worksheets/sheet${i + 1}.xml`) ?? orderedParts[i]?.data
    if (part === undefined) continue
    sheets.push(makeSheet(names[i] ?? `Sheet${i + 1}`, parseGrid(decode(part), shared)))
  }
  if (sheets.length === 0) return { ok: false, error: "xlsx: no worksheet found" }
  return { ok: true, sheets }
}

// ── tool wrapper ─────────────────────────────────────────────────────────────

const errResult = (output: string, failure?: ToolResult["failure"]): ToolResult =>
  failure === undefined ? { ok: false, output } : { ok: false, output, failure }

const renderTable = (sheet: XlsxSheet, maxRows: number): string => {
  const shown = Math.min(sheet.rowCount, maxRows)
  const lines: string[] = [
    `Sheet "${sheet.name}" (${sheet.rowCount} row${sheet.rowCount === 1 ? "" : "s"}):`,
  ]
  for (let r = 0; r < shown; r++) {
    const cells: string[] = []
    for (let c = 0; ; c++) {
      const v = sheet.cellAt(r, c)
      // Stop a row at the first run of trailing empties by probing a small window.
      if (v === "" && sheet.cellAt(r, c + 1) === "" && sheet.cellAt(r, c + 2) === "") break
      cells.push(v)
    }
    lines.push(`  ${cells.join(" | ")}`)
  }
  if (sheet.rowCount > maxRows) lines.push("  … (more rows truncated by maxRows)")
  return lines.join("\n")
}

export const xlsxReadTool: Tool<XlsxReadInput> = {
  name: "xlsx_read",
  description:
    "Read an XLSX spreadsheet: returns per-sheet cell values as a text table. " +
    "Pure-TS OOXML reader (STORED + DEFLATE); optional `sheet` name + `maxRows`. Read-only.",
  inputSchema: xlsxReadInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async *execute(input: XlsxReadInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = xlsxReadInputSchema.safeParse(input)
    if (!parsed.success) {
      yield { type: "result", result: errResult(`invalid input: ${parsed.error.message}`) }
      return
    }
    const bytesResult = await readJailedFileBytes(ctx, parsed.data.path, MAX_XLSX_BYTES)
    if (!bytesResult.ok) {
      yield { type: "result", result: bytesResult.result }
      return
    }
    const out = parseXlsx(bytesResult.bytes)
    if (!out.ok) {
      yield {
        type: "result",
        result: errResult(out.error, { mode: "error", modelVisibleError: "xlsx_malformed" }),
      }
      return
    }
    const wanted = parsed.data.sheet
    const maxRows = parsed.data.maxRows ?? DEFAULT_MAX_ROWS
    // No `sheet` ⇒ render EVERY sheet (so a multi-sheet workbook surfaces all of
    // its data); a named `sheet` ⇒ that one only.
    if (wanted === undefined) {
      const output = out.sheets.map((s) => renderTable(s, maxRows)).join("\n\n")
      yield { type: "result", result: { ok: true, output } }
      return
    }
    const sheet = out.sheets.find((s) => s.name === wanted)
    if (sheet === undefined) {
      yield {
        type: "result",
        result: errResult(`sheet not found: "${wanted}"`, {
          mode: "not_found",
          path: parsed.data.path,
        }),
      }
      return
    }
    yield { type: "result", result: { ok: true, output: renderTable(sheet, maxRows) } }
  },
}

// ── shared FS-jail byte read (used by xlsx_read + docx_read) ──────────────────

export type JailedBytes =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly result: ToolResult }

/** Resolve + jail + symlink-reject + size-cap + read a doc's bytes. No-throw. */
export const readJailedFileBytes = async (
  ctx: ToolContext,
  visiblePath: string,
  maxBytes: number,
): Promise<JailedBytes> => {
  let abs: string
  try {
    abs = resolveJailedDoc(ctx.cwd, visiblePath, "doc")
  } catch (e) {
    if (e instanceof FsJailError) {
      return {
        ok: false,
        result: errResult(`path outside cwd: ${visiblePath}`, {
          mode: "permission_denied",
          path: visiblePath,
          isReadonly: true,
        }),
      }
    }
    return {
      ok: false,
      result: errResult(`path outside cwd: ${visiblePath} (${errMessage(e)})`, {
        mode: "permission_denied",
        path: visiblePath,
        isReadonly: true,
      }),
    }
  }
  try {
    const st = await lstat(abs)
    if (st.isSymbolicLink()) {
      return {
        ok: false,
        result: errResult(`symlink not allowed: ${visiblePath}`, {
          mode: "permission_denied",
          path: visiblePath,
          isReadonly: true,
        }),
      }
    }
    if (st.size > maxBytes) {
      return {
        ok: false,
        result: errResult(`file too large: ${visiblePath} (${st.size} bytes)`, {
          mode: "error",
          modelVisibleError: "doc_too_large",
        }),
      }
    }
  } catch (e) {
    const msg = errMessage(e)
    const isEnoent =
      typeof e === "object" && e !== null && (e as { code?: unknown }).code === "ENOENT"
    return {
      ok: false,
      result: errResult(isEnoent ? `File not found: ${visiblePath}` : `lstat failed: ${msg}`, {
        ...(isEnoent
          ? { mode: "not_found" as const, path: visiblePath }
          : { mode: "error" as const, modelVisibleError: msg }),
      }),
    }
  }
  try {
    return { ok: true, bytes: new Uint8Array(await readFile(abs)) }
  } catch (e) {
    return {
      ok: false,
      result: errResult(`read failed: ${errMessage(e)}`, {
        mode: "error",
        modelVisibleError: errMessage(e),
      }),
    }
  }
}
