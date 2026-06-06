/**
 * Hellgate (jun-06 ADVERSARIAL audit) — OOXML numeric-char-ref DoS across ALL
 * three readers (xlsx / docx / pptx).
 *
 * REAL BUG (found this round): each reader's inline `unescapeXml` resolved
 * numeric character references with `String.fromCodePoint(parseInt(...))`
 * UNGUARDED. `String.fromCodePoint` throws `RangeError` for a code point that is
 * NaN, negative, or past Unicode's ceiling (0x10FFFF). A hostile cell / paragraph
 * / run carrying `&#x110000;` or `&#9999999999;` therefore threw OUT of the
 * `parseXlsx` / `parseDocx` / `parsePptx` core — none of which is wrapped in a
 * try/catch by its tool `execute` — crashing the tool dispatch (a no-throw
 * contract violation reachable from any attacker-supplied document).
 *
 * FIX: all three readers now share the RANGE-SAFE `unescapeXml`
 * (`@/tool/document/authoring/ooxml-read`), whose `safeCodePoint` drops an
 * out-of-range OR surrogate code point to "" instead of throwing.
 *
 * RED before the fix (each `parse*` threw); GREEN after (typed result, hostile
 * ref dropped, surrounding text preserved).
 */

import { describe, expect, test } from "bun:test"
import { buildStoredZip, textEntry } from "@/tool/document/authoring/zip-store"
import { parseDocx } from "@/tool/document/docx-read"
import { parsePptx } from "@/tool/document/pptx-read"
import { parseXlsx } from "@/tool/document/xlsx-read"

const xlsxFrom = (cellInner: string): Uint8Array =>
  buildStoredZip([
    textEntry("xl/workbook.xml", `<workbook><sheets><sheet name="S"/></sheets></workbook>`),
    textEntry(
      "xl/worksheets/sheet1.xml",
      `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${cellInner}</t></is></c></row></sheetData></worksheet>`,
    ),
  ])

const docxFrom = (runText: string): Uint8Array =>
  buildStoredZip([
    textEntry(
      "word/document.xml",
      `<w:document><w:body><w:p><w:r><w:t>${runText}</w:t></w:r></w:p></w:body></w:document>`,
    ),
  ])

const pptxFrom = (runText: string): Uint8Array =>
  buildStoredZip([
    textEntry(
      "ppt/slides/slide1.xml",
      `<p:sld><p:cSld><p:spTree><p:sp><a:p><a:r><a:t>${runText}</a:t></a:r></a:p></p:sp></p:spTree></p:cSld></p:sld>`,
    ),
  ])

const HOSTILE = ["&#x110000;", "&#9999999999;", "&#xFFFFFFFF;", "&#xD800;"]

describe("OOXML numeric char-ref DoS — no-throw across xlsx/docx/pptx (jun-06)", () => {
  for (const ref of HOSTILE) {
    test(`xlsx: hostile ref ${ref} → no throw, surrounding text preserved`, () => {
      let r: ReturnType<typeof parseXlsx> | undefined
      expect(() => {
        r = parseXlsx(xlsxFrom(`a${ref}b`))
      }).not.toThrow()
      expect(r?.ok).toBe(true)
      if (r?.ok) expect(r.sheets[0]?.cellAt(0, 0)).toBe("ab")
    })

    test(`docx: hostile ref ${ref} → no throw, surrounding text preserved`, () => {
      let r: ReturnType<typeof parseDocx> | undefined
      expect(() => {
        r = parseDocx(docxFrom(`x${ref}y`))
      }).not.toThrow()
      expect(r?.ok).toBe(true)
      if (r?.ok) expect(r.paragraphs[0]).toBe("xy")
    })

    test(`pptx: hostile ref ${ref} → no throw, surrounding text preserved`, () => {
      let r: ReturnType<typeof parsePptx> | undefined
      expect(() => {
        r = parsePptx(pptxFrom(`p${ref}q`))
      }).not.toThrow()
      expect(r?.ok).toBe(true)
      if (r?.ok) expect(r.text).toBe("pq")
    })
  }

  test("VALID astral ref (&#x1F680;) is preserved in all three readers", () => {
    const xr = parseXlsx(xlsxFrom("go&#x1F680;"))
    const dr = parseDocx(docxFrom("go&#x1F680;"))
    const pr = parsePptx(pptxFrom("go&#x1F680;"))
    expect(xr.ok && xr.sheets[0]?.cellAt(0, 0) === "go\u{1F680}").toBe(true)
    expect(dr.ok && dr.paragraphs[0] === "go\u{1F680}").toBe(true)
    expect(pr.ok && pr.text === "go\u{1F680}").toBe(true)
  })

  test("output stays well-formed after a lone-surrogate ref in every reader", () => {
    const xr = parseXlsx(xlsxFrom("p&#xDC00;q"))
    const dr = parseDocx(docxFrom("p&#xDC00;q"))
    const pr = parsePptx(pptxFrom("p&#xDC00;q"))
    expect(xr.ok && xr.sheets[0]?.cellAt(0, 0).isWellFormed()).toBe(true)
    expect(dr.ok && (dr.paragraphs[0] ?? "").isWellFormed()).toBe(true)
    expect(pr.ok && pr.text.isWellFormed()).toBe(true)
  })
})
