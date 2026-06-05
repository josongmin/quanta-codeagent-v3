/**
 * Hellgate (ROUND 3 — ALGORITHM-CORRECTNESS deep-read) — OOXML self-closing
 * element POSITIONAL DRIFT.
 *
 * REAL BUG (found this round, fixed in `xlsx-read.ts` + `docx-read.ts`):
 *
 *   The cell/paragraph regexes used a paired-tag alternative
 *   `<c\b[^>]*>([\s\S]*?)<\/c>` (resp. `<w:p\b[^>]*>…</w:p>`) whose greedy
 *   `[^>]*` HAPPILY matched across a SELF-CLOSING element. Given the
 *   real-world Excel/Word fragment:
 *
 *       <c r="A1" s="1"/><c r="B1"><v>5</v></c>
 *
 *   the first alternative anchored its `>` on the SECOND cell's `>`, swallowing
 *   the self-closing `<c r="A1" s="1"/>` whole. The regex then reported ONE
 *   cell whose ref was `A1` (from the swallowed attrs) but whose value was `5`
 *   (from the second cell) — placing the value at the WRONG column. Every
 *   value in a row containing a styled-but-empty cell shifted ONE COLUMN LEFT
 *   (silent spreadsheet corruption). Word `<w:p/>` blank paragraphs were
 *   likewise DROPPED, shifting every later paragraph's index — directly
 *   contradicting `parseDocx`'s docstring ("blank paragraphs are preserved
 *   positionally").
 *
 *   Excel emits self-closing styled-empty cells (`<c r=".." s=".."/>`) and Word
 *   emits self-closing blank paragraphs (`<w:p/>`) ROUTINELY, so this corrupted
 *   ordinary documents, not just crafted ones.
 *
 *   FIX: a `(?<!\/)>` negative lookbehind on the paired-tag alternative forbids
 *   it from matching a `/>`, forcing the self-closing alternative to claim the
 *   element as its own (empty) cell/paragraph at the correct position.
 *
 * These cases are RED before the fix (asserting the corrupt shifted output) and
 * GREEN after.
 */

import { describe, expect, test } from "bun:test"
import { buildStoredZip, textEntry } from "@/tool/document/authoring/zip-store"
import { parseDocx } from "@/tool/document/docx-read"
import { parseXlsx } from "@/tool/document/xlsx-read"

const xlsxFrom = (sheetXml: string, sharedXml?: string): Uint8Array => {
  const parts = [
    textEntry("xl/workbook.xml", `<workbook><sheets><sheet name="S1"/></sheets></workbook>`),
    textEntry(
      "xl/worksheets/sheet1.xml",
      `<worksheet><sheetData><row r="1">${sheetXml}</row></sheetData></worksheet>`,
    ),
  ]
  if (sharedXml !== undefined) parts.push(textEntry("xl/sharedStrings.xml", sharedXml))
  return buildStoredZip(parts)
}

const rowCells = (sheetXml: string, n: number, sharedXml?: string): string[] => {
  const r = parseXlsx(xlsxFrom(sheetXml, sharedXml))
  if (!r.ok) throw new Error(`parse failed: ${r.error}`)
  const s = r.sheets[0]
  if (s === undefined) throw new Error("no sheet")
  const out: string[] = []
  for (let c = 0; c < n; c++) out.push(s.cellAt(0, c))
  return out
}

const docxFrom = (bodyXml: string): Uint8Array =>
  buildStoredZip([
    textEntry("word/document.xml", `<w:document><w:body>${bodyXml}</w:body></w:document>`),
  ])

describe("OOXML self-closing positional drift (R3 algorithm-correctness)", () => {
  test("xlsx: self-closing styled-empty cell does NOT shift the next value left", () => {
    // A1 styled-empty (self-close), B1=5. Value must land at column 1 (B), NOT 0.
    const cells = rowCells(`<c r="A1" s="1"/><c r="B1"><v>5</v></c>`, 3)
    expect(cells).toEqual(["", "5", ""])
  })

  test("xlsx: multiple self-closing cells interleaved with values keep ALL columns", () => {
    // A empty / B=5 / C empty / D=7 — the realistic styled-empty pattern.
    const cells = rowCells(
      `<c r="A1" s="1"/><c r="B1"><v>5</v></c><c r="C1" s="1"/><c r="D1"><v>7</v></c>`,
      6,
    )
    expect(cells).toEqual(["", "5", "", "7", "", ""])
  })

  test("xlsx: self-closing cell at END of row is preserved (no swallow of </row>)", () => {
    const cells = rowCells(`<c r="A1"><v>1</v></c><c r="B1" s="1"/>`, 3)
    expect(cells).toEqual(["1", "", ""])
  })

  test("xlsx: self-closing shared-string-typed empty then real value (no ref drift)", () => {
    // A1 self-close (empty), B1 shared-string idx 0 -> "hi".
    const cells = rowCells(
      `<c r="A1" s="1"/><c r="B1" t="s"><v>0</v></c>`,
      3,
      `<sst><si><t>hi</t></si></sst>`,
    )
    expect(cells).toEqual(["", "hi", ""])
  })

  test("xlsx: paired empty cell <c></c> (NOT self-closing) still parses fine", () => {
    // Regression guard: the lookbehind must NOT break the ordinary paired tag.
    const cells = rowCells(`<c r="A1"></c><c r="B1"><v>9</v></c>`, 3)
    expect(cells).toEqual(["", "9", ""])
  })

  test("docx: self-closing blank paragraph <w:p/> is PRESERVED positionally", () => {
    const r = parseDocx(
      docxFrom(
        `<w:p><w:r><w:t>first</w:t></w:r></w:p><w:p/><w:p><w:r><w:t>third</w:t></w:r></w:p>`,
      ),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // The blank paragraph must occupy index 1 — NOT be dropped (which would
    // make "third" land at index 1).
    expect(r.paragraphs).toEqual(["first", "", "third"])
    expect(r.text).toBe("first\n\nthird")
  })

  test("docx: trailing self-closing blank paragraph preserved", () => {
    const r = parseDocx(docxFrom(`<w:p><w:r><w:t>only</w:t></w:r></w:p><w:p/>`))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.paragraphs).toEqual(["only", ""])
  })

  test("docx: ordinary paired paragraphs unaffected by the lookbehind", () => {
    const r = parseDocx(
      docxFrom(`<w:p><w:r><w:t>a</w:t></w:r></w:p><w:p><w:r><w:t>b</w:t></w:r></w:p>`),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.paragraphs).toEqual(["a", "b"])
  })
})
