/**
 * H14b — minimal-but-VALID `.xlsx` (SpreadsheetML) serializer.
 *
 * Produces a workbook Excel / LibreOffice / Google Sheets open cleanly, built
 * from these spec-minimal parts (ECMA-376 / ISO 29500 Part 1):
 *   - `[Content_Types].xml`          — part MIME types
 *   - `_rels/.rels`                  — package → workbook
 *   - `xl/workbook.xml`              — sheet list
 *   - `xl/_rels/workbook.xml.rels`   — workbook → each sheet + sharedStrings
 *   - `xl/worksheets/sheet{N}.xml`   — the grid (one per sheet)
 *   - `xl/sharedStrings.xml`         — the string pool (canonical SpreadsheetML)
 *
 * Cell typing: a cell whose value is a finite `number` is written as a numeric
 * cell (`<c r="A1"><v>…</v></c>`); everything else is coerced to a string and
 * written via the SHARED-STRING table (`t="s"`, index into sharedStrings). The
 * shared-string table is the canonical Excel mechanism and lets a duplicated
 * label be stored once.
 *
 * Pure: `buildXlsx(spec) => Uint8Array`. No clock, no randomness, no FS. The
 * ZIP container is the dependency-free STORED writer ({@link buildStoredZip}).
 */

import { buildContentTypesXml, buildRelsXml, REL_OFFICE_DOCUMENT, XML_DECL, xmlText } from "./ooxml"
import { buildStoredZip, textEntry, type ZipEntry } from "./zip-store"

/** A single cell value. `null`/`undefined` ⇒ empty cell. */
export type XlsxCellValue = string | number | boolean | null | undefined

/** One sheet: a name + a 2-D array of rows (each row an array of cell values). */
export interface XlsxSheetSpec {
  /** Sheet tab name. Excel caps at 31 chars and forbids `: \ / ? * [ ]`; the
   *  serializer sanitizes (see {@link sanitizeSheetName}) so any input is safe. */
  readonly name: string
  /** Rows of cells. Ragged rows are fine (short rows just have fewer cells). */
  readonly rows: ReadonlyArray<ReadonlyArray<XlsxCellValue>>
}

export interface XlsxSpec {
  readonly sheets: readonly XlsxSheetSpec[]
}

const SHEET_NAME_FORBIDDEN = new Set([":", "\\", "/", "?", "*", "[", "]"])

/** Excel sheet-name rules: ≤31 chars, none of `: \ / ? * [ ]`, non-empty. */
export const sanitizeSheetName = (name: string, index: number): string => {
  let cleaned = ""
  for (const ch of name) {
    if (!SHEET_NAME_FORBIDDEN.has(ch)) cleaned += ch
  }
  cleaned = cleaned.trim().slice(0, 31)
  if (cleaned.length === 0) cleaned = `Sheet${index + 1}`
  return cleaned
}

/** A1-style column letter from a 0-based column index (0 → A, 26 → AA). */
export const columnLetter = (col: number): string => {
  let n = col
  let s = ""
  do {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return s
}

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)

// ── string pool ──────────────────────────────────────────────────────────────
// We collect every string cell into an ordered, de-duplicated pool so each
// distinct string is serialized once; cells reference it by index (`t="s"`).
class StringPool {
  private readonly index = new Map<string, number>()
  readonly entries: string[] = []
  intern(s: string): number {
    const existing = this.index.get(s)
    if (existing !== undefined) return existing
    const id = this.entries.length
    this.index.set(s, id)
    this.entries.push(s)
    return id
  }
}

/** Coerce any non-number cell value to its string form (booleans → TRUE/FALSE,
 *  matching how a spreadsheet renders a literal boolean entry). */
const cellToString = (v: XlsxCellValue): string => {
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE"
  return String(v)
}

const buildSheetXml = (sheet: XlsxSheetSpec, pool: StringPool): string => {
  const rowsXml: string[] = []
  for (let r = 0; r < sheet.rows.length; r++) {
    const row = sheet.rows[r]
    if (row === undefined) continue
    const cellsXml: string[] = []
    for (let c = 0; c < row.length; c++) {
      const v = row[c]
      if (v === null || v === undefined || v === "") continue // empty cell — omit
      const ref = `${columnLetter(c)}${r + 1}`
      if (isFiniteNumber(v)) {
        cellsXml.push(`<c r="${ref}"><v>${v}</v></c>`)
      } else {
        const id = pool.intern(cellToString(v))
        cellsXml.push(`<c r="${ref}" t="s"><v>${id}</v></c>`)
      }
    }
    rowsXml.push(`<row r="${r + 1}">${cellsXml.join("")}</row>`)
  }
  return (
    `${XML_DECL}` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${rowsXml.join("")}</sheetData>` +
    `</worksheet>`
  )
}

const buildSharedStringsXml = (pool: StringPool): string => {
  const count = pool.entries.length
  const items = pool.entries
    .map((s) => `<si><t xml:space="preserve">${xmlText(s)}</t></si>`)
    .join("")
  return (
    `${XML_DECL}` +
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${count}" uniqueCount="${count}">` +
    `${items}</sst>`
  )
}

const buildWorkbookXml = (names: readonly string[]): string => {
  const sheets = names
    .map((n, i) => `<sheet name="${xmlText(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join("")
  return (
    `${XML_DECL}` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets>${sheets}</sheets></workbook>`
  )
}

const REL_WORKSHEET =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"
const REL_SHARED_STRINGS =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings"
const CT_WORKBOOK = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
const CT_WORKSHEET = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"
const CT_SHARED_STRINGS =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"

/**
 * Serialize an {@link XlsxSpec} to `.xlsx` bytes. Always produces at least one
 * sheet (an empty spec yields a single blank "Sheet1" — Excel rejects a
 * zero-sheet workbook). Pure + deterministic.
 */
export const buildXlsx = (spec: XlsxSpec): Uint8Array => {
  const inputSheets = spec.sheets.length > 0 ? spec.sheets : [{ name: "Sheet1", rows: [] }]
  const names = inputSheets.map((s, i) => sanitizeSheetName(s.name, i))

  const pool = new StringPool()
  const sheetParts = inputSheets.map((s) => buildSheetXml(s, pool))
  // sharedStrings must be built AFTER every sheet has interned its strings.
  const sharedStringsXml = buildSharedStringsXml(pool)

  // workbook.xml.rels: one rId per sheet, then sharedStrings as the next rId.
  const sheetRels = names.map((_, i) => ({
    id: `rId${i + 1}`,
    type: REL_WORKSHEET,
    target: `worksheets/sheet${i + 1}.xml`,
  }))
  const ssRelId = `rId${names.length + 1}`
  const workbookRels = [
    ...sheetRels,
    { id: ssRelId, type: REL_SHARED_STRINGS, target: "sharedStrings.xml" },
  ]

  const contentTypes = buildContentTypesXml([
    {
      kind: "default",
      extension: "rels",
      contentType: "application/vnd.openxmlformats-package.relationships+xml",
    },
    { kind: "default", extension: "xml", contentType: "application/xml" },
    { kind: "override", partName: "/xl/workbook.xml", contentType: CT_WORKBOOK },
    { kind: "override", partName: "/xl/sharedStrings.xml", contentType: CT_SHARED_STRINGS },
    ...names.map((_, i) => ({
      kind: "override" as const,
      partName: `/xl/worksheets/sheet${i + 1}.xml`,
      contentType: CT_WORKSHEET,
    })),
  ])

  const packageRels = buildRelsXml([
    { id: "rId1", type: REL_OFFICE_DOCUMENT, target: "xl/workbook.xml" },
  ])

  const entries: ZipEntry[] = [
    textEntry("[Content_Types].xml", contentTypes),
    textEntry("_rels/.rels", packageRels),
    textEntry("xl/workbook.xml", buildWorkbookXml(names)),
    textEntry("xl/_rels/workbook.xml.rels", buildRelsXml(workbookRels)),
    textEntry("xl/sharedStrings.xml", sharedStringsXml),
    ...sheetParts.map((xml, i) => textEntry(`xl/worksheets/sheet${i + 1}.xml`, xml)),
  ]
  return buildStoredZip(entries)
}
