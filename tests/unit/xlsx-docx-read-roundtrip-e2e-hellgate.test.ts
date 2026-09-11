/**
 * e2e Hellgate — the TRUE round-trip the H14b agent could NOT do.
 *
 * H14b's e2e (`office-authoring-e2e-hellgate.test.ts`) had to re-read the
 * authored `.xlsx` through quanta's OWN `parseStoredZip` + a regex cell parse,
 * because `xlsx_read` was a stub. With the real reader landed, this closes the
 * loop through the ACTUAL tools end-to-end:
 *
 *   xlsx_write (real .xlsx on disk) → xlsx_read tool → cells come back
 *   docx_write (real .docx on disk) → docx_read tool → text comes back
 *
 * Plus a DEFLATE-compressed (method 8) real-world-shaped fixture, proving the
 * reader is not STORED-only.
 *
 * Both readers are wired by `buildDefaultTools({officeAuthoring:true})` (the
 * same knob that wires the writers — the office read/write cluster ships
 * together, default-OFF).
 */

import { afterEach, describe, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { deflateRawSync } from "node:zlib"
import { buildDefaultTools } from "@/tool"
import { buildXlsx } from "@/tool/document/authoring/xlsx"
import { textEntry, unzip, type ZipEntry } from "@/tool/document/authoring/zip-store"
import type { Tool, ToolContext, ToolResult } from "@/tool/types"
import { makeTempDirOwner } from "../_helpers/temp-dir"

/**
 * Every temp root this file makes, removed in `afterEach` whether the case
 * passed, failed, or threw. Before this, each `mkdtempSync` here had no `rm`
 * anywhere in the file and left one directory per case per run.
 */
const tempRoots = makeTempDirOwner()
afterEach(() => {
  tempRoots.disposeAll()
})

const ctx = (cwd: string): ToolContext => ({ cwd, signal: new AbortController().signal })

const run = async (tool: Tool, input: unknown, c: ToolContext): Promise<ToolResult> => {
  let last: ToolResult | undefined
  for await (const ev of tool.execute(input as never, c)) {
    if (ev.type === "result") last = ev.result
  }
  if (last === undefined) throw new Error("no result")
  return last
}

const toolByName = (tools: Tool[], name: string): Tool => {
  const t = tools.find((x) => x.name === name)
  if (t === undefined) throw new Error(`tool not registered: ${name}`)
  return t
}

// DEFLATE (method 8) zip builder — proves non-STORED real-world support.
const buildDeflateZip = (entries: readonly ZipEntry[]): Uint8Array => {
  const u16 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff]
  const u32 = (n: number): number[] => [
    n & 0xff,
    (n >>> 8) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 24) & 0xff,
  ]
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  const crc32 = (b: Uint8Array): number => {
    let crc = 0xffffffff
    for (let i = 0; i < b.length; i++)
      crc = (table[(crc ^ (b[i] as number)) & 0xff] as number) ^ (crc >>> 8)
    return (crc ^ 0xffffffff) >>> 0
  }
  const out: number[] = []
  const central: number[] = []
  const enc = new TextEncoder()
  let offset = 0
  let count = 0
  for (const e of entries) {
    const name = [...enc.encode(e.path)]
    const comp = new Uint8Array(deflateRawSync(Buffer.from(e.data)))
    const crc = crc32(e.data)
    const local = [
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(0x0800),
      ...u16(8),
      ...u16(0),
      ...u16(0),
      ...u32(crc),
      ...u32(comp.length),
      ...u32(e.data.length),
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
      ...u32(e.data.length),
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

describe("xlsx/docx read e2e — readers are base tools (always on)", () => {
  test("xlsx_read + docx_read are BASE readers (present with or without officeAuthoring)", () => {
    // jun-04 — readers are pure/read-only, so (like csv/yaml/pdf/ndjson + the
    // now-real xlsx_read) they live in the BASE set, NOT gated by the WRITER
    // knob `officeAuthoring`. Only the mutating xlsx_write/docx_write are gated.
    const on = buildDefaultTools({ officeAuthoring: true }).map((t) => t.name)
    expect(on).toContain("xlsx_read")
    expect(on).toContain("docx_read")
    const off = buildDefaultTools().map((t) => t.name)
    expect(off).toContain("xlsx_read")
    expect(off).toContain("docx_read")
    // The mutating writers stay gated by the knob.
    expect(off).not.toContain("xlsx_write")
    expect(on).toContain("xlsx_write")
  })
})

describe("xlsx_write → xlsx_read TRUE round-trip", () => {
  test("write real .xlsx (multi-sheet, XML-special, numbers) → read back via tool", async () => {
    const tools = buildDefaultTools({ officeAuthoring: true })
    const dir = tempRoots.create("xlsx-rt-")
    const writeRes = await run(
      toolByName(tools, "xlsx_write"),
      {
        path: "data.xlsx",
        sheets: [
          {
            name: "Sales",
            rows: [
              ["Region", "Rev", "Note <x>&\"'"],
              ["North", 1200, "ok"],
              ["South", 980.5, "watch"],
            ],
          },
          {
            name: "Meta",
            rows: [
              ["key", "val"],
              ["env", "prod"],
            ],
          },
        ],
      },
      ctx(dir),
    )
    expect(writeRes.ok).toBe(true)

    const readRes = await run(toolByName(tools, "xlsx_read"), { path: "data.xlsx" }, ctx(dir))
    expect(readRes.ok).toBe(true)
    // Real cells come back through the tool output (not a deferral).
    expect(readRes.output).not.toContain("not yet implemented")
    expect(readRes.output).toContain("Region")
    expect(readRes.output).toContain("Note <x>&\"'") // XML-special un-escaped
    expect(readRes.output).toContain("1200")
    expect(readRes.output).toContain("980.5")
    expect(readRes.output).toContain("Sales")
    expect(readRes.output).toContain("Meta") // second sheet name surfaced
    expect(readRes.output).toContain("prod")
  })

  test("reading a specific sheet by name", async () => {
    const tools = buildDefaultTools({ officeAuthoring: true })
    const dir = tempRoots.create("xlsx-rt2-")
    await run(
      toolByName(tools, "xlsx_write"),
      {
        path: "two.xlsx",
        sheets: [
          { name: "A", rows: [["one"]] },
          { name: "B", rows: [["two"]] },
        ],
      },
      ctx(dir),
    )
    const r = await run(toolByName(tools, "xlsx_read"), { path: "two.xlsx", sheet: "B" }, ctx(dir))
    expect(r.ok).toBe(true)
    expect(r.output).toContain("two")
  })
})

describe("docx_write → docx_read TRUE round-trip", () => {
  test("write real .docx → read text back via tool", async () => {
    const tools = buildDefaultTools({ officeAuthoring: true })
    const dir = tempRoots.create("docx-rt-")
    const writeRes = await run(
      toolByName(tools, "docx_write"),
      {
        path: "report.docx",
        paragraphs: [
          { kind: "heading", level: 1, text: "Findings <2024>" },
          { kind: "paragraph", runs: [{ text: "First " }, { text: "claim", bold: true }] },
          { kind: "paragraph", runs: [{ text: "Second & final." }] },
        ],
      },
      ctx(dir),
    )
    expect(writeRes.ok).toBe(true)

    const readRes = await run(toolByName(tools, "docx_read"), { path: "report.docx" }, ctx(dir))
    expect(readRes.ok).toBe(true)
    expect(readRes.output).toContain("Findings <2024>") // un-escaped heading
    expect(readRes.output).toContain("First claim")
    expect(readRes.output).toContain("Second & final.")
  })
})

describe("DEFLATE real-world-shaped fixture reads correctly through the tool", () => {
  test("a method-8 .xlsx on disk reads back (not STORED-only)", async () => {
    const tools = buildDefaultTools({ officeAuthoring: true })
    const dir = tempRoots.create("xlsx-deflate-")
    // Author a STORED xlsx in-memory, re-zip its parts as DEFLATE, write to disk.
    const stored = buildXlsx({ sheets: [{ name: "Z", rows: [["compressed", 7]] }] })
    const parts = unzip(stored)
    expect(parts.ok).toBe(true)
    if (!parts.ok) return
    const deflated = buildDeflateZip(
      parts.entries.map((e): ZipEntry => textEntry(e.path, new TextDecoder().decode(e.data))),
    )
    await writeFile(join(dir, "deflate.xlsx"), deflated)
    const r = await run(toolByName(tools, "xlsx_read"), { path: "deflate.xlsx" }, ctx(dir))
    expect(r.ok).toBe(true)
    expect(r.output).toContain("compressed")
    expect(r.output).toContain("7")
  })
})
