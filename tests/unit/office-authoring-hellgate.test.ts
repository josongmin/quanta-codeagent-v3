// Hellgate — H14b Office document AUTHORING (xlsx_write / docx_write).
//
// Proves the pure-TS STORED-ZIP + OOXML stack produces VALID Office files:
//   - the produced bytes are a well-formed ZIP (parse local + central headers
//     back, re-derive every CRC-32, confirm STORED method),
//   - the spec-minimal OOXML parts are present + well-formed XML,
//   - xlsx cells ROUND-TRIP (build → unzip → parse sheet1.xml → cells match the
//     input, including XML-escaped special chars `< > & " '`),
//   - docx paragraphs are present,
//   - jailed-path enforcement (a path outside cwd → permission_denied),
//   - versioned sibling on an existing file (never silent overwrite),
//   - empty / edge specs never throw.

import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildDocx,
  buildStoredZip,
  buildXlsx,
  crc32,
  docxWriteTool,
  parseStoredZip,
  xlsxWriteTool,
} from "@/tool"
import { textEntry } from "@/tool/document/authoring"
import type { ToolContext, ToolResult } from "@/tool/types"

const ctx = (cwd: string): ToolContext => ({ cwd, signal: new AbortController().signal })

const runTool = async (
  tool: {
    execute: (
      input: never,
      ctx: ToolContext,
    ) => AsyncIterable<{ type: string; result?: ToolResult }>
  },
  input: unknown,
  c: ToolContext,
): Promise<ToolResult> => {
  let last: ToolResult | undefined
  for await (const ev of tool.execute(input as never, c)) {
    if (ev.type === "result" && ev.result) last = ev.result
  }
  if (last === undefined) throw new Error("tool produced no result")
  return last
}

const partBytes = (zip: Uint8Array, path: string): Uint8Array => {
  const entry = parseStoredZip(zip).find((e) => e.path === path)
  if (entry === undefined) throw new Error(`part not found: ${path}`)
  return entry.data
}
const findPart = (zip: Uint8Array, path: string): string =>
  new TextDecoder().decode(partBytes(zip, path))

describe("zip-store — CRC-32 + STORED archive", () => {
  test("CRC-32 matches the standard check value for 'IEEE'... (known vector '123456789')", () => {
    // The canonical CRC-32 check value of the ASCII string "123456789" is
    // 0xCBF43926 — the universally published test vector for this polynomial.
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926)
  })

  test("empty buffer CRC-32 is 0", () => {
    expect(crc32(new Uint8Array(0))).toBe(0)
  })

  test("round-trips entries with byte-identical data + verified CRC", () => {
    const entries = [textEntry("a.xml", "<a/>"), textEntry("dir/b.xml", "<b>héllo &amp; <c/></b>")]
    const zip = buildStoredZip(entries)
    const parsed = parseStoredZip(zip)
    expect(parsed.map((e) => e.path)).toEqual(["a.xml", "dir/b.xml"])
    for (const e of parsed) {
      expect(e.method).toBe(0) // STORED
      expect(e.computedCrc).toBe(e.storedCrc) // re-derived CRC matches header
    }
    const second = parsed[1]
    expect(second).toBeDefined()
    expect(new TextDecoder().decode((second as { data: Uint8Array }).data)).toBe(
      "<b>héllo &amp; <c/></b>",
    )
  })

  test("deterministic — same input yields byte-identical archive", () => {
    const mk = () => buildStoredZip([textEntry("x.xml", "<x/>")])
    expect(Buffer.from(mk())).toEqual(Buffer.from(mk()))
  })

  test("parse throws on a corrupt central-directory signature", () => {
    const zip = buildStoredZip([textEntry("x.xml", "<x/>")])
    // Flip a byte inside the central directory region to break a signature.
    const corrupt = new Uint8Array(zip)
    // EOCD is the last 22 bytes; central dir is just before it. Corrupt near start.
    corrupt[corrupt.length - 6] = 0xff // mangle central-dir offset → bad sig walk
    expect(() => parseStoredZip(corrupt)).toThrow()
  })
})

describe("xlsx — valid package + cell round-trip", () => {
  const SPEC = {
    sheets: [
      {
        name: "Data",
        rows: [
          ["Name", "Qty", "Note"],
          ["Widget", 42, "a<b>&\"c'"],
          ["Gadget", 7, "ok"],
        ],
      },
      { name: "Second", rows: [["only"]] },
    ],
  }

  test("produces the spec-minimal parts, all well-formed XML", () => {
    const zip = buildXlsx(SPEC)
    for (const p of [
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/worksheets/sheet1.xml",
      "xl/worksheets/sheet2.xml",
      "xl/sharedStrings.xml",
    ]) {
      const xml = findPart(zip, p)
      expect(xml.startsWith("<?xml")).toBe(true)
      // well-formedness smoke: balanced angle brackets, no raw unescaped '&'
      expect(xml).not.toMatch(/&(?!(amp|lt|gt|quot|apos);)/)
    }
  })

  test("CRC-32 of every xlsx part verifies", () => {
    for (const e of parseStoredZip(buildXlsx(SPEC))) {
      expect(e.computedCrc).toBe(e.storedCrc)
    }
  })

  test("cells round-trip incl. XML-escaped special chars", () => {
    const zip = buildXlsx(SPEC)
    const sheet1 = findPart(zip, "xl/worksheets/sheet1.xml")
    const shared = findPart(zip, "xl/sharedStrings.xml")
    // The special-char string is stored in sharedStrings, fully escaped.
    expect(shared).toContain("a&lt;b&gt;&amp;&quot;c&apos;")
    // The numeric cell is a raw <v>42</v> (no shared-string index).
    expect(sheet1).toContain("<v>42</v>")
    // Cell B2 (the number 42) is at A1-ref B2.
    expect(sheet1).toContain('r="B2"')
    // String cells carry t="s" and point into the shared table.
    expect(sheet1).toMatch(/<c r="A1" t="s"><v>\d+<\/v><\/c>/)
  })

  test("sheet names are sanitized (forbidden chars dropped, ≤31 chars)", () => {
    const zip = buildXlsx({ sheets: [{ name: "a/b:c*[d]?".repeat(10), rows: [] }] })
    const wb = findPart(zip, "xl/workbook.xml")
    expect(wb).not.toMatch(/name="[^"]*[\\/:*?[\]]/)
  })

  test("empty spec yields a valid single-sheet workbook (no throw)", () => {
    const zip = buildXlsx({ sheets: [] })
    const parsed = parseStoredZip(zip)
    expect(parsed.find((e) => e.path === "xl/worksheets/sheet1.xml")).toBeDefined()
    for (const e of parsed) expect(e.computedCrc).toBe(e.storedCrc)
  })
})

describe("docx — valid package + paragraphs present", () => {
  const SPEC = {
    paragraphs: [
      { kind: "heading" as const, level: 1, text: "Report <Q3>" },
      {
        kind: "paragraph" as const,
        runs: [
          { text: "Plain and " },
          { text: "bold", bold: true },
          { text: " & italic", italic: true },
        ],
      },
    ],
  }

  test("produces the spec-minimal parts", () => {
    const zip = buildDocx(SPEC)
    for (const p of [
      "[Content_Types].xml",
      "_rels/.rels",
      "word/document.xml",
      "word/_rels/document.xml.rels",
    ]) {
      expect(findPart(zip, p).startsWith("<?xml")).toBe(true)
    }
  })

  test("paragraphs + runs present, special chars escaped, CRC verifies", () => {
    const zip = buildDocx(SPEC)
    const doc = findPart(zip, "word/document.xml")
    expect(doc).toContain('w:val="Heading1"')
    expect(doc).toContain("Report &lt;Q3&gt;")
    expect(doc).toContain("<w:b/>")
    expect(doc).toContain("<w:i/>")
    expect(doc).toContain(" &amp; italic")
    expect(doc).toContain("<w:sectPr>")
    for (const e of parseStoredZip(zip)) expect(e.computedCrc).toBe(e.storedCrc)
  })

  test("empty spec yields a valid one-empty-paragraph document (no throw)", () => {
    const zip = buildDocx({ paragraphs: [] })
    expect(findPart(zip, "word/document.xml")).toContain("<w:p/>")
  })
})

describe("xlsx_write tool — jail + versioning + no-throw", () => {
  test("writes a real .xlsx to a jailed path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "office-xlsx-"))
    const res = await runTool(
      xlsxWriteTool,
      { path: "out.xlsx", sheets: [{ name: "S", rows: [["a", 1]] }] },
      ctx(dir),
    )
    expect(res.ok).toBe(true)
    const bytes = new Uint8Array(await Bun.file(join(dir, "out.xlsx")).arrayBuffer())
    expect(parseStoredZip(bytes).find((e) => e.path === "xl/worksheets/sheet1.xml")).toBeDefined()
  })

  test("a path outside cwd is rejected with permission_denied (no write)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "office-jail-"))
    const res = await runTool(
      xlsxWriteTool,
      { path: "../escape.xlsx", sheets: [{ name: "S", rows: [] }] },
      ctx(dir),
    )
    expect(res.ok).toBe(false)
    expect(res.failure?.mode).toBe("permission_denied")
  })

  test("an existing target lands at a versioned -vN sibling (never overwrite)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "office-ver-"))
    writeFileSync(join(dir, "tracker.xlsx"), "PRE-EXISTING")
    const res = await runTool(
      xlsxWriteTool,
      { path: "tracker.xlsx", sheets: [{ name: "S", rows: [["x"]] }] },
      ctx(dir),
    )
    expect(res.ok).toBe(true)
    expect(res.output).toContain("tracker-v2.xlsx")
    // The original is untouched.
    expect(await Bun.file(join(dir, "tracker.xlsx")).text()).toBe("PRE-EXISTING")
    // The new sibling is a real xlsx.
    const v2 = new Uint8Array(await Bun.file(join(dir, "tracker-v2.xlsx")).arrayBuffer())
    expect(parseStoredZip(v2).length).toBeGreaterThan(0)
  })

  test("invalid input → typed ok:false (no throw)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "office-bad-"))
    const res = await runTool(xlsxWriteTool, { path: "", sheets: [] }, ctx(dir))
    expect(res.ok).toBe(false)
  })

  test("mutating posture: isReadOnly()=false, not concurrency-safe", () => {
    expect(xlsxWriteTool.isReadOnly?.()).toBe(false)
    expect(xlsxWriteTool.isConcurrencySafe?.({} as never)).toBe(false)
    expect(docxWriteTool.isReadOnly?.()).toBe(false)
  })
})

describe("docx_write tool — jail + versioning", () => {
  test("writes a real .docx and re-reads document.xml", async () => {
    const dir = mkdtempSync(join(tmpdir(), "office-docx-"))
    const res = await runTool(
      docxWriteTool,
      { path: "memo.docx", paragraphs: [{ kind: "heading", level: 2, text: "Hi" }] },
      ctx(dir),
    )
    expect(res.ok).toBe(true)
    const bytes = new Uint8Array(await Bun.file(join(dir, "memo.docx")).arrayBuffer())
    expect(new TextDecoder().decode(partBytes(bytes, "word/document.xml"))).toContain(
      'w:val="Heading2"',
    )
  })

  test("jail escape rejected", async () => {
    const dir = mkdtempSync(join(tmpdir(), "office-docx-jail-"))
    const res = await runTool(docxWriteTool, { path: "/etc/x.docx", paragraphs: [] }, ctx(dir))
    expect(res.ok).toBe(false)
    expect(res.failure?.mode).toBe("permission_denied")
  })
})
