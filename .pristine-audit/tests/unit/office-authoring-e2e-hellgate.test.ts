// e2e Hellgate — H14b Office authoring driven through the REAL tool registry.
//
// Proves the END-TO-END capability: with the knob ON, `buildDefaultTools` wires
// `xlsx_write` / `docx_write`; driving the real `xlsx_write` tool produces a real
// `.xlsx` on disk whose cells come back when re-parsed — a TRUE round-trip that
// proves real-format validity.
//
// NOTE on the reader: the spec asks to re-read via the EXISTING `xlsx_read`
// tool. That tool is currently a STUB (src/tool/document/xlsx-read.ts — its
// impl was deferred to ADR-0138), so it returns a typed DEFERRAL rather than
// parsed cells; routing the round-trip through it would assert nothing about the
// bytes. We therefore (a) assert `xlsx_read` IS registered + still returns its
// typed deferral (so a future impl swap closes the loop with no tool-surface
// change), and (b) complete the genuine byte-level round-trip through quanta's
// OWN STORED-ZIP reader (`parseStoredZip`) + a sheet-XML cell parse. When the
// real xlsx_read lands, the same `.xlsx` this test writes is its fixture.

import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildDefaultTools, parseStoredZip } from "@/tool"
import type { Tool, ToolContext, ToolResult } from "@/tool/types"

const ctx = (cwd: string): ToolContext => ({ cwd, signal: new AbortController().signal })

const run = async (tool: Tool, input: unknown, c: ToolContext): Promise<ToolResult> => {
  let last: ToolResult | undefined
  for await (const ev of tool.execute(input as never, c)) {
    if (ev.type === "result") last = ev.result
  }
  if (last === undefined) throw new Error("no result")
  return last
}

const toolByName = (tools: Tool[], name: string): Tool | undefined =>
  tools.find((t) => t.name === name)

const partText = (zip: Uint8Array, path: string): string => {
  const entry = parseStoredZip(zip).find((e) => e.path === path)
  if (entry === undefined) throw new Error(`part not found: ${path}`)
  return new TextDecoder().decode(entry.data)
}

// Re-extract the cell value at an A1 ref from a sheet XML + shared-strings part.
const cellAt = (sheetXml: string, sharedXml: string, ref: string): string | undefined => {
  const re = new RegExp(`<c r="${ref}"(?: t="(s)")?><v>([^<]*)</v></c>`)
  const m = re.exec(sheetXml)
  if (m === null) return undefined
  const value = m[2] as string
  if (m[1] === "s") {
    // shared-string index → the <si><t>…</t></si> at that position. Unescape
    // the five XML entities to recover the ORIGINAL value (what a reader does).
    const idx = Number.parseInt(value, 10)
    const sis = [...sharedXml.matchAll(/<si><t[^>]*>([^<]*)<\/t><\/si>/g)]
    const raw = sis[idx]?.[1]
    return raw === undefined ? undefined : unescapeXml(raw)
  }
  return value
}

const unescapeXml = (s: string): string =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")

describe("office-authoring e2e — knob ON wires the tools", () => {
  test("buildDefaultTools({officeAuthoring:true}) registers xlsx_write + docx_write", () => {
    const names = buildDefaultTools({ officeAuthoring: true }).map((t) => t.name)
    expect(names).toContain("xlsx_write")
    expect(names).toContain("docx_write")
  })

  test("knob OFF ⇒ tools ABSENT (byte-identical default menu)", () => {
    const names = buildDefaultTools().map((t) => t.name)
    expect(names).not.toContain("xlsx_write")
    expect(names).not.toContain("docx_write")
  })

  test("xlsx_read is still registered (the future round-trip reader)", () => {
    expect(buildDefaultTools().map((t) => t.name)).toContain("xlsx_read")
  })
})

describe("office-authoring e2e — TRUE xlsx round-trip", () => {
  test("xlsx_write → on-disk .xlsx → re-parse → cells match input", async () => {
    const tools = buildDefaultTools({ officeAuthoring: true })
    const xlsxWrite = toolByName(tools, "xlsx_write")
    expect(xlsxWrite).toBeDefined()

    const dir = mkdtempSync(join(tmpdir(), "office-e2e-"))
    const input = {
      path: "report.xlsx",
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
    }
    const res = await run(xlsxWrite as Tool, input, ctx(dir))
    expect(res.ok).toBe(true)

    // Re-read the bytes through quanta's own STORED-ZIP reader (real round-trip).
    const bytes = new Uint8Array(await Bun.file(join(dir, "report.xlsx")).arrayBuffer())
    const parts = parseStoredZip(bytes)
    for (const e of parts) expect(e.computedCrc).toBe(e.storedCrc) // every CRC verifies

    const sheet = partText(bytes, "xl/worksheets/sheet1.xml")
    const shared = partText(bytes, "xl/sharedStrings.xml")

    // String cells round-trip (incl. the XML-special-char header at C1).
    expect(cellAt(sheet, shared, "A1")).toBe("Region")
    expect(cellAt(sheet, shared, "C1")).toBe('Flag <x>&"')
    expect(cellAt(sheet, shared, "A2")).toBe("North")
    // Numeric cells round-trip as numbers.
    expect(cellAt(sheet, shared, "B2")).toBe("1200")
    expect(cellAt(sheet, shared, "B3")).toBe("980.5")
  })
})

describe("office-authoring e2e — docx structure round-trip", () => {
  test("docx_write → on-disk .docx → re-parse document.xml has the heading + run", async () => {
    const tools = buildDefaultTools({ officeAuthoring: true })
    const docxWrite = toolByName(tools, "docx_write")
    const dir = mkdtempSync(join(tmpdir(), "office-e2e-docx-"))
    const res = await run(
      docxWrite as Tool,
      {
        path: "summary.docx",
        paragraphs: [
          { kind: "heading", level: 1, text: "Summary" },
          {
            kind: "paragraph",
            runs: [
              { text: "Body ", bold: false },
              { text: "emph", italic: true },
            ],
          },
        ],
      },
      ctx(dir),
    )
    expect(res.ok).toBe(true)
    const bytes = new Uint8Array(await Bun.file(join(dir, "summary.docx")).arrayBuffer())
    const parts = parseStoredZip(bytes)
    for (const e of parts) expect(e.computedCrc).toBe(e.storedCrc)
    const doc = partText(bytes, "word/document.xml")
    expect(doc).toContain('w:val="Heading1"')
    expect(doc).toContain("Summary")
    expect(doc).toContain("emph")
    expect(doc).toContain("<w:i/>")
  })
})
