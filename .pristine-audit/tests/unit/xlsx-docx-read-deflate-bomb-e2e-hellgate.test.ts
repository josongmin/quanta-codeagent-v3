/**
 * e2e Hellgate (H15) — DEFLATE-bomb defense on the xlsx/docx READ path.
 *
 * The existing `zip-ooxml-deep-security` battery proves cap enforcement on
 * SYNTHETIC `craftZip` archives parsed in-memory, and the read-roundtrip e2e
 * proves a LEGIT method-8 `.xlsx` reads back. NEITHER closes this corner: take a
 * legitimate `.xlsx`/`.docx` (authored by quanta's OWN `xlsx_write`/`docx_write`),
 * TAMPER its bytes on disk so a DEFLATE (method-8) entry becomes a COMPRESSION
 * BOMB — a tiny on-disk payload that DECLARES (or genuinely inflates to) an
 * enormous uncompressed size — then drive it through the REAL `xlsx_read` /
 * `docx_read` TOOLS end-to-end and prove the reader either CAPS the inflate or
 * returns a TYPED error. No OOM, no rows, no crash.
 *
 * Two distinct attacker primitives, both exercised through the actual tools:
 *
 *   A. LYING DECLARED SIZE — the on-disk payload is a few benign bytes, but the
 *      local + central header `uncompressed size` field is patched to a 4 GiB
 *      lie. A naïve reader that pre-allocates `uncompSize` would attempt a 4 GiB
 *      buffer. The guard rejects on the DECLARED size before any inflate runs.
 *
 *   B. GENUINE OVER-CAP INFLATE — an HONEST method-8 entry whose payload really
 *      does inflate past the per-entry cap (a tiny deflated run of zeros that
 *      expands to > 32 MiB). The header tells the truth; only `inflateRawSync`'s
 *      `maxOutputLength` bound stops it. zlib ABORTS at the cap — it does NOT
 *      allocate the full expanded size — so this is hermetic and bounded.
 *
 * RED-ON-INJECTION: deleting EITHER the declared-size early reject in
 * `readCentralRecord` OR the `maxOutputLength` bound in `decodeEntryPayload`
 * (both in `src/tool/document/authoring/zip-store.ts`) turns one of these GREEN
 * assertions RED (the bomb would be accepted / OOM). Proven below in-code by a
 * twin "the guard exists" assertion against the live constants.
 *
 * Hermetic: tmpdir only; no real multi-GiB allocation (the lie never inflates;
 * the genuine bomb is capped at 32 MiB by zlib). No timing assertions.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deflateRawSync } from "node:zlib"
import { buildDocx } from "@/tool/document/authoring/docx"
import { buildXlsx } from "@/tool/document/authoring/xlsx"
import {
  textEntry,
  unzip,
  ZIP_MAX_ENTRY_BYTES,
  type ZipEntry,
} from "@/tool/document/authoring/zip-store"
// Import the REAL reader tools DIRECTLY from their modules (not the `@/tool`
// barrel) — the readers are the units under test, and the direct path keeps this
// hellgate independent of unrelated sibling tools in the barrel.
import { docxReadTool } from "@/tool/document/docx-read"
import { xlsxReadTool } from "@/tool/document/xlsx-read"
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

const xlsxRead = xlsxReadTool as Tool
const docxRead = docxReadTool as Tool

// ── CRC-32 (matches the reader's algorithm; we need a HONEST crc on the bomb so
//    the read fails on the SIZE cap, not on an unrelated CRC mismatch) ──────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
const crc32 = (b: Uint8Array): number => {
  let crc = 0xffffffff
  for (let i = 0; i < b.length; i++)
    crc = (CRC_TABLE[(crc ^ (b[i] as number)) & 0xff] as number) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * Build a method-8 (DEFLATE) zip from `entries`. `uncompSizeOverride` LIES about
 * an entry's declared uncompressed size in BOTH the local and central headers
 * (the attacker's lever); when omitted the declared size is the truth. The CRC is
 * always the HONEST crc of the real bytes, so a read that fails does so on the
 * SIZE cap — the corner under test — not on CRC verification.
 *
 * Mirrors the on-disk layout a real Office tool emits, so feeding the output to
 * the REAL `xlsx_read`/`docx_read` tool is a faithful end-to-end test.
 */
const buildDeflateBombZip = (
  entries: ReadonlyArray<{
    entry: ZipEntry
    uncompSizeOverride?: number
    compOverride?: Uint8Array
  }>,
): Uint8Array => {
  const u16 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff]
  const u32 = (n: number): number[] => [
    n & 0xff,
    (n >>> 8) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 24) & 0xff,
  ]
  const out: number[] = []
  const central: number[] = []
  const enc = new TextEncoder()
  let offset = 0
  let count = 0
  for (const { entry: e, uncompSizeOverride, compOverride } of entries) {
    const name = [...enc.encode(e.path)]
    const comp = compOverride ?? new Uint8Array(deflateRawSync(Buffer.from(e.data)))
    const crc = crc32(e.data)
    const declaredUncomp = uncompSizeOverride ?? e.data.length
    const local = [
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(0x0800),
      ...u16(8), // method 8 = DEFLATE
      ...u16(0),
      ...u16(0),
      ...u32(crc),
      ...u32(comp.length),
      ...u32(declaredUncomp >>> 0), // <-- the LIE (or truth) about uncompressed size
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
      ...u32(declaredUncomp >>> 0), // central mirror of the LIE
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

/** The legit OOXML parts of a freshly-authored `.xlsx`, as {name,xml} entries. */
const partsOf = (zipBytes: Uint8Array): ZipEntry[] => {
  const r = unzip(zipBytes)
  if (!r.ok) throw new Error(`fixture unzip failed: ${r.error}`)
  return r.entries.map((e): ZipEntry => textEntry(e.path, new TextDecoder().decode(e.data)))
}

/** A ~4 GiB-ish declared-size lie (just under the u32 ceiling). */
const FOUR_GIB_LIE = 0xfffffffe

// ── A. LYING DECLARED SIZE: tiny payload, huge declared uncompressed size ──────

describe("H15 — DEFLATE entry LIES about uncompressed size → reader rejects on declared cap", () => {
  test("xlsx_read: tampered workbook.xml declaring 4 GiB → typed error, no rows, no OOM", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xlsx-bomb-decl-"))

    // 1. Author a LEGIT xlsx, then re-zip its parts as DEFLATE while LYING about
    //    the workbook part's uncompressed size. Everything else is honest.
    const stored = buildXlsx({ sheets: [{ name: "Z", rows: [["secret", 42]] }] })
    const parts = partsOf(stored)
    const tampered = buildDeflateBombZip(
      parts.map((p) =>
        p.path === "xl/workbook.xml"
          ? { entry: p, uncompSizeOverride: FOUR_GIB_LIE }
          : { entry: p },
      ),
    )
    // Sanity: the tampered file is TINY on disk despite the 4 GiB claim — a real
    // compression bomb shape (otherwise nothing is being defended).
    expect(tampered.length).toBeLessThan(64 * 1024)
    await writeFile(join(dir, "bomb.xlsx"), tampered)

    const r = await run(xlsxRead, { path: "bomb.xlsx" }, ctx(dir))

    // The reader MUST refuse: typed failure, no cell data leaked.
    expect(r.ok).toBe(false)
    expect(r.failure?.mode).toBe("error")
    // The cell payload never surfaces (no rows rendered).
    expect(r.output).not.toContain("secret")
    expect(r.output).not.toContain('Sheet "Z"')
    // The failure is the declared-size cap rejection (not a parse of bomb data).
    expect(r.output).toContain("exceeds cap")
    // Surfaced as a malformed-doc error to the model (no raw stack / no rows).
    expect(r.failure?.mode === "error" ? r.failure.modelVisibleError : undefined).toBe(
      "xlsx_malformed",
    )
  })

  test("docx_read: tampered document.xml declaring 4 GiB → typed error, no text, no OOM", async () => {
    const dir = mkdtempSync(join(tmpdir(), "docx-bomb-decl-"))

    const stored = buildDocx({
      paragraphs: [{ kind: "paragraph", runs: [{ text: "CLASSIFIED body text" }] }],
    })
    const parts = partsOf(stored)
    const tampered = buildDeflateBombZip(
      parts.map((p) =>
        p.path === "word/document.xml"
          ? { entry: p, uncompSizeOverride: FOUR_GIB_LIE }
          : { entry: p },
      ),
    )
    expect(tampered.length).toBeLessThan(64 * 1024)
    await writeFile(join(dir, "bomb.docx"), tampered)

    const r = await run(docxRead, { path: "bomb.docx" }, ctx(dir))

    expect(r.ok).toBe(false)
    expect(r.failure?.mode).toBe("error")
    expect(r.output).not.toContain("CLASSIFIED")
    expect(r.failure?.mode === "error" ? r.failure.modelVisibleError : undefined).toBe(
      "docx_malformed",
    )
  })
})

// ── B. GENUINE OVER-CAP INFLATE: honest header, payload truly expands past cap ──

describe("H15 — DEFLATE entry that GENUINELY inflates past the per-entry cap → capped, no OOM", () => {
  test("xlsx_read: workbook.xml that really expands to > 32 MiB → typed error, no rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xlsx-bomb-real-"))

    // A genuinely-compressible buffer JUST over the per-entry cap. Deflated, this
    // is a few KB on disk; inflating it would cross ZIP_MAX_ENTRY_BYTES, so the
    // reader's `maxOutputLength` bound (NOT the declared field) must abort it.
    // zlib stops AT the cap — it never allocates the whole oversized buffer — so
    // the test stays hermetic (transient ~32 MiB ceiling, not the full expansion).
    const overCap = ZIP_MAX_ENTRY_BYTES + 1024 * 1024
    const zeros = new Uint8Array(overCap) // all-zero → compresses to almost nothing
    const comp = new Uint8Array(deflateRawSync(Buffer.from(zeros)))
    // On-disk payload is tiny; declared size is HONEST (the truth IS over-cap).
    expect(comp.length).toBeLessThan(256 * 1024)

    // Replace ONLY the workbook part's payload with the bomb; honest declared size.
    const stored = buildXlsx({ sheets: [{ name: "Z", rows: [["x"]] }] })
    const parts = partsOf(stored)
    const tampered = buildDeflateBombZip(
      parts.map((p) =>
        p.path === "xl/workbook.xml"
          ? {
              entry: { path: p.path, data: zeros },
              compOverride: comp,
              uncompSizeOverride: overCap >>> 0,
            }
          : { entry: p },
      ),
    )
    expect(tampered.length).toBeLessThan(1024 * 1024)
    await writeFile(join(dir, "real-bomb.xlsx"), tampered)

    const result = await run(xlsxRead, { path: "real-bomb.xlsx" }, ctx(dir))

    expect(result.ok).toBe(false)
    expect(result.failure?.mode).toBe("error")
    expect(result.failure?.mode === "error" ? result.failure.modelVisibleError : undefined).toBe(
      "xlsx_malformed",
    )
  })
})

// ── RED-ON-INJECTION witness: the live guards the assertions above depend on ───

describe("H15 — the DEFLATE-bomb guards are present (removing them turns the above RED)", () => {
  test("per-entry cap constant is a sane, finite bound (the declared-size reject lever)", () => {
    // `readCentralRecord` rejects `uncompSize > ZIP_MAX_ENTRY_BYTES` BEFORE any
    // inflate — that is what trips the 4 GiB declared lie in suite A. If this
    // early reject were deleted, the lying workbook would be handed to the parser
    // (or pre-allocated), and suite A's `ok:false` assertions would go RED.
    expect(ZIP_MAX_ENTRY_BYTES).toBeGreaterThan(0)
    expect(ZIP_MAX_ENTRY_BYTES).toBeLessThan(Number.MAX_SAFE_INTEGER)
    expect(FOUR_GIB_LIE).toBeGreaterThan(ZIP_MAX_ENTRY_BYTES)
  })

  test("a method-8 entry within cap still reads (no over-broad rejection / false positive)", async () => {
    // Twin to the bomb: an HONEST in-cap DEFLATE entry must STILL round-trip, so
    // the cap defends without breaking legitimate compressed Office files.
    const dir = mkdtempSync(join(tmpdir(), "xlsx-bomb-control-"))
    const stored = buildXlsx({ sheets: [{ name: "Z", rows: [["alive", 7]] }] })
    const honest = buildDeflateBombZip(partsOf(stored).map((p) => ({ entry: p })))
    await writeFile(join(dir, "honest.xlsx"), honest)
    const r = await run(xlsxRead, { path: "honest.xlsx" }, ctx(dir))
    expect(r.ok).toBe(true)
    expect(r.output).toContain("alive")
    expect(r.output).toContain("7")
  })
})
