/**
 * Hellgate — REAL `xlsx_read` + `docx_read` readers (H14b round-trip closeout).
 *
 * The H14b slice shipped pure-TS Office AUTHORING (`buildXlsx`/`buildDocx`,
 * STORED-ZIP + OOXML) but `xlsx_read` was a STUB returning a typed deferral.
 * This battery seals the REAL readers built on an extended zip-store that
 * inflates DEFLATE entries (`node:zlib.inflateRawSync`) as well as STORED ones,
 * and parses the OOXML parts:
 *
 *   - STORED archives (what `buildXlsx`/`buildDocx` emit) read back.
 *   - DEFLATE archives (what real-world Excel/Word emit) read back.
 *   - Malformed / truncated ZIP → typed `ok:false`, NO throw.
 *   - Missing parts → graceful typed failure.
 *   - Huge declared size → capped (no OOM).
 *   - Shared-string index out of range → safe (empty, no crash).
 *   - Empty sheet → empty grid.
 *   - XML-escaped content (`<>&"'`) un-escaped on read.
 *   - Path jail enforcement (traversal rejected).
 *
 * Pure-core tests use `parseXlsx`/`parseDocx`/`unzip` directly; tool-level
 * tests drive `xlsxReadTool`/`docxReadTool` through their `execute` generators.
 */

import { describe, expect, test } from "bun:test"
import { deflateRawSync } from "node:zlib"
import { buildDocx } from "@/tool/document/authoring/docx"
import { buildXlsx } from "@/tool/document/authoring/xlsx"
import {
  buildStoredZip,
  textEntry,
  unzip,
  type ZipEntry,
} from "@/tool/document/authoring/zip-store"
import { docxReadTool, parseDocx } from "@/tool/document/docx-read"
import { parseXlsx, xlsxReadTool } from "@/tool/document/xlsx-read"
import type { ToolContext } from "@/tool/types"

const ctx = (cwd: string): ToolContext => ({ cwd, signal: new AbortController().signal })

const runTool = async (
  tool: typeof xlsxReadTool | typeof docxReadTool,
  input: unknown,
  c: ToolContext,
): Promise<{ ok: boolean; output: string }> => {
  let last: { ok: boolean; output: string } | null = null
  for await (const ev of tool.execute(input as never, c)) {
    if (ev.type === "result") last = { ok: ev.result.ok, output: ev.result.output }
  }
  return last ?? { ok: false, output: "no result" }
}

/** Build a DEFLATE-compressed ZIP by hand (compression method 8) so we can
 *  prove the reader handles real-world office files, not just our STORED ones.
 *  Reuses the same header layout as `buildStoredZip` but with method 8 + the
 *  deflated payload. Local helper — the writer deliberately stays STORED-only. */
const buildDeflateZip = (entries: readonly ZipEntry[]): Uint8Array => {
  const u16 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff]
  const u32 = (n: number): number[] => [
    n & 0xff,
    (n >>> 8) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 24) & 0xff,
  ]
  // CRC-32 (same poly as zip-store) — recomputed locally to keep the fixture
  // self-contained.
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  const crc32 = (b: Uint8Array): number => {
    let crc = 0xffffffff
    for (let i = 0; i < b.length; i++) crc = (table[(crc ^ (b[i] as number)) & 0xff] as number) ^ (crc >>> 8)
    return (crc ^ 0xffffffff) >>> 0
  }
  const out: number[] = []
  const central: number[] = []
  const enc = new TextEncoder()
  let offset = 0
  let count = 0
  for (const e of entries) {
    const name = enc.encode(e.path)
    const raw = e.data
    const comp = new Uint8Array(deflateRawSync(Buffer.from(raw)))
    const crc = crc32(raw)
    const local = [
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(0x0800),
      ...u16(8), // method DEFLATE
      ...u16(0),
      ...u16(0),
      ...u32(crc),
      ...u32(comp.length),
      ...u32(raw.length),
      ...u16(name.length),
      ...u16(0),
      ...name,
      ...comp,
    ]
    central.push(
      ...u32(0x02014b50),
      ...u16(20),
      ...u16(20),
      ...u16(0x0800),
      ...u16(8),
      ...u16(0),
      ...u16(0),
      ...u32(crc),
      ...u32(comp.length),
      ...u32(raw.length),
      ...u16(name.length),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(offset),
      ...name,
    )
    out.push(...local)
    offset += local.length
    count++
  }
  const centralStart = offset
  out.push(...central)
  out.push(
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(count),
    ...u16(count),
    ...u32(central.length),
    ...u32(centralStart),
    ...u16(0),
  )
  return new Uint8Array(out)
}

describe("xlsx_read hellgate — STORED round-trip (pure parseXlsx)", () => {
  test("HELL-1: buildXlsx (STORED) → parseXlsx → cells match", () => {
    const bytes = buildXlsx({
      sheets: [
        {
          name: "Q3",
          rows: [
            ["Region", "Revenue", 'Flag <x>&"'],
            ["North", 1200, "ok"],
            ["South", 980.5, "watch"],
          ],
        },
      ],
    })
    const r = parseXlsx(bytes)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.sheets.length).toBe(1)
    const s = r.sheets[0]
    expect(s?.name).toBe("Q3")
    // A1=Region, C1=XML-special header, A2=North, B2=1200 (numeric), B3=980.5
    expect(s?.cellAt(0, 0)).toBe("Region")
    expect(s?.cellAt(0, 2)).toBe('Flag <x>&"') // un-escaped
    expect(s?.cellAt(1, 0)).toBe("North")
    expect(s?.cellAt(1, 1)).toBe("1200")
    expect(s?.cellAt(2, 1)).toBe("980.5")
  })
})

describe("xlsx_read hellgate — DEFLATE support (real-world shape)", () => {
  test("HELL-2: DEFLATE-compressed xlsx parts inflate + parse", () => {
    // Re-zip the parts of a STORED xlsx as DEFLATE — same OOXML, method 8.
    const stored = buildXlsx({ sheets: [{ name: "S", rows: [["hi", 42]] }] })
    const parts = unzip(stored)
    expect(parts.ok).toBe(true)
    if (!parts.ok) return
    const deflated = buildDeflateZip(
      parts.entries.map((e) => ({ path: e.path, data: e.data })),
    )
    const r = parseXlsx(deflated)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.sheets[0]?.cellAt(0, 0)).toBe("hi")
    expect(r.sheets[0]?.cellAt(0, 1)).toBe("42")
  })
})

describe("xlsx_read hellgate — adversarial / no-throw", () => {
  test("HELL-3: malformed ZIP (random bytes) → typed ok:false, no throw", () => {
    const r = parseXlsx(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))
    expect(r.ok).toBe(false)
  })

  test("HELL-4: missing sharedStrings part → graceful (string cells empty, no crash)", () => {
    // workbook + one sheet referencing shared-string idx 0, but NO sharedStrings.
    const sheetXml =
      '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>'
    const wb =
      '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheets><sheet name="X" sheetId="1" r:id="rId1"/></sheets></workbook>'
    const zip = buildStoredZip([
      textEntry("xl/workbook.xml", wb),
      textEntry("xl/worksheets/sheet1.xml", sheetXml),
    ])
    const r = parseXlsx(zip)
    // No sharedStrings ⇒ shared-string ref resolves to "" (safe), parse succeeds.
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.sheets[0]?.cellAt(0, 0)).toBe("")
  })

  test("HELL-5: missing workbook.xml → typed failure", () => {
    const zip = buildStoredZip([textEntry("xl/sharedStrings.xml", "<sst/>")])
    const r = parseXlsx(zip)
    expect(r.ok).toBe(false)
  })

  test("HELL-6: huge declared uncompressed size → capped (no OOM, typed failure)", () => {
    // Hand-craft a local header claiming a 4 GB uncompressed size for a STORED
    // entry. The reader must reject on the size cap, not attempt the allocation.
    const u16 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff]
    const u32 = (n: number): number[] => [
      n & 0xff,
      (n >>> 8) & 0xff,
      (n >>> 16) & 0xff,
      (n >>> 24) & 0xff,
    ]
    const name = [...new TextEncoder().encode("xl/workbook.xml")]
    const HUGE = 0xffffffff
    const local = [
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(HUGE), // compressed size
      ...u32(HUGE), // uncompressed size
      ...u16(name.length),
      ...u16(0),
      ...name,
    ]
    const central = [
      ...u32(0x02014b50),
      ...u16(20),
      ...u16(20),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(HUGE),
      ...u32(HUGE),
      ...u16(name.length),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(0),
      ...name,
    ]
    const eocd = [
      ...u32(0x06054b50),
      ...u16(0),
      ...u16(0),
      ...u16(1),
      ...u16(1),
      ...u32(central.length),
      ...u32(local.length),
      ...u16(0),
    ]
    const zip = new Uint8Array([...local, ...central, ...eocd])
    const r = parseXlsx(zip)
    expect(r.ok).toBe(false)
  })

  test("HELL-7: shared-string index out of range → safe empty string", () => {
    const sheetXml =
      '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetData><row r="1"><c r="A1" t="s"><v>999</v></c></row></sheetData></worksheet>'
    const wb =
      '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheets><sheet name="X" sheetId="1" r:id="rId1"/></sheets></workbook>'
    const ss =
      '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>only</t></si></sst>'
    const zip = buildStoredZip([
      textEntry("xl/workbook.xml", wb),
      textEntry("xl/sharedStrings.xml", ss),
      textEntry("xl/worksheets/sheet1.xml", sheetXml),
    ])
    const r = parseXlsx(zip)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.sheets[0]?.cellAt(0, 0)).toBe("") // out-of-range ⇒ "", not a crash
  })

  test("HELL-8: empty sheet → ok with empty grid", () => {
    const bytes = buildXlsx({ sheets: [{ name: "Empty", rows: [] }] })
    const r = parseXlsx(bytes)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.sheets[0]?.name).toBe("Empty")
    expect(r.sheets[0]?.rowCount).toBe(0)
  })

  test("HELL-9: inline-string cell (t=\"inlineStr\") un-escaped", () => {
    const sheetXml =
      '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>a &amp; b &lt;c&gt;</t></is></c></row></sheetData></worksheet>'
    const wb =
      '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheets><sheet name="X" sheetId="1" r:id="rId1"/></sheets></workbook>'
    const zip = buildStoredZip([
      textEntry("xl/workbook.xml", wb),
      textEntry("xl/worksheets/sheet1.xml", sheetXml),
    ])
    const r = parseXlsx(zip)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.sheets[0]?.cellAt(0, 0)).toBe("a & b <c>")
  })

  test("HELL-9b: hostile mega-column ref (`ZZZZZZ1`) does NOT drive unbounded allocation", () => {
    // A cell whose `r=` ref has many letters resolves to an astronomical column
    // index (`ZZZZZZ` ≈ 321 million). Before the fix, the reader sized a row
    // array up to that index (`while (cells.length <= col) push("")`), turning a
    // few-byte cell into a multi-second hang / OOM. The clamp to Excel's XFD
    // ceiling keeps this fast + bounded. We assert it completes well under a
    // second (it would take >10s unclamped) and returns a typed ok result.
    const wb =
      '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheets><sheet name="S1" sheetId="1" r:id="rId1"/></sheets></workbook>'
    const sheetXml =
      '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetData><row r="1"><c r="ZZZZZZ1" t="s"><v>0</v></c></row></sheetData></worksheet>'
    const zip = buildStoredZip([
      textEntry("xl/workbook.xml", wb),
      textEntry("xl/worksheets/sheet1.xml", sheetXml),
    ])
    const started = performance.now()
    const r = parseXlsx(zip)
    const elapsedMs = performance.now() - started
    expect(r.ok).toBe(true)
    // Bound: the clamp makes this a few ms; the unclamped allocation took ~13s.
    // A 2s ceiling is a wide margin that still fails hard on the regression.
    expect(elapsedMs).toBeLessThan(2000)
  })
})

describe("xlsx_read hellgate — tool surface", () => {
  test("HELL-10: metadata — read-only + concurrency-safe + name", () => {
    expect(xlsxReadTool.name).toBe("xlsx_read")
    expect(xlsxReadTool.isReadOnly?.()).toBe(true)
    expect(xlsxReadTool.isConcurrencySafe?.({ path: "x.xlsx" } as never)).toBe(true)
  })

  test("HELL-11: bad input shape → ok:false (no throw)", async () => {
    const r = await runTool(xlsxReadTool, {}, ctx("/tmp"))
    expect(r.ok).toBe(false)
  })

  test("HELL-12: path traversal rejected (jail)", async () => {
    const r = await runTool(xlsxReadTool, { path: "../../etc/passwd" }, ctx("/tmp/jail-root-xyz"))
    expect(r.ok).toBe(false)
    expect(r.output.toLowerCase()).toContain("path outside")
  })
})

describe("docx_read hellgate", () => {
  test("HELL-13: buildDocx (STORED) → parseDocx → paragraph text", () => {
    const bytes = buildDocx({
      paragraphs: [
        { kind: "heading", level: 1, text: "Title <x>" },
        { kind: "paragraph", runs: [{ text: "Body " }, { text: "emph", italic: true }] },
      ],
    })
    const r = parseDocx(bytes)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.paragraphs[0]).toBe("Title <x>") // un-escaped
    expect(r.paragraphs[1]).toBe("Body emph") // runs concatenated
    expect(r.text).toContain("Title <x>")
    expect(r.text).toContain("Body emph")
  })

  test("HELL-14: DEFLATE docx parts inflate + parse", () => {
    const stored = buildDocx({ paragraphs: [{ kind: "paragraph", runs: [{ text: "hello" }] }] })
    const parts = unzip(stored)
    expect(parts.ok).toBe(true)
    if (!parts.ok) return
    const deflated = buildDeflateZip(parts.entries.map((e) => ({ path: e.path, data: e.data })))
    const r = parseDocx(deflated)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text).toContain("hello")
  })

  test("HELL-15: missing word/document.xml → typed failure", () => {
    const zip = buildStoredZip([textEntry("foo.xml", "<x/>")])
    const r = parseDocx(zip)
    expect(r.ok).toBe(false)
  })

  test("HELL-16: malformed bytes → ok:false no throw", () => {
    expect(parseDocx(new Uint8Array([9, 9, 9])).ok).toBe(false)
  })

  test("HELL-17: tool metadata + jail", async () => {
    expect(docxReadTool.name).toBe("docx_read")
    expect(docxReadTool.isReadOnly?.()).toBe(true)
    const r = await runTool(docxReadTool, { path: "../escape.docx" }, ctx("/tmp/jail-root-abc"))
    expect(r.ok).toBe(false)
  })
})
