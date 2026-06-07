/**
 * Round-2 adversarial hardening — OOXML/ZIP READER CRC VERIFICATION (jun-04).
 *
 * Round-1 sealed the DEFLATE total-cap bomb in `zip-store.ts`. Its RESIDUAL
 * risk: `unzip` computed nothing about CRC — it sliced/inflated the payload and
 * returned it WITHOUT comparing against the central-directory CRC-32. A tampered
 * or bit-rotted `.xlsx`/`.docx`/`.pptx` whose payload no longer matches its
 * declared CRC was accepted as VALID, so a corrupted spreadsheet silently
 * yielded wrong cells (SILENT CORRUPTION). The docstring even claimed "CRC
 * mismatches are reported" while the code did not.
 *
 * REAL BUG sealed this round (zip-store `unzip` CRC-verify):
 *   `unzip` now recomputes CRC-32 over the decoded bytes of EVERY entry (STORED
 *   and DEFLATE) and rejects a mismatch with a typed `ok:false` `crc-mismatch`
 *   failure — never returning corrupt bytes as if valid.
 *
 * Every test is adversarial: a corrupted CRC field, a tampered DEFLATE payload,
 * a truncated central directory, a bad EOCD, a payload that runs past EOF — each
 * must surface as a typed failure with NO throw. And a VALID archive from
 * `buildXlsx`/`buildDocx`/`buildPptx` must STILL round-trip (no false rejection).
 *
 * Pure: no FS, no network. All zips are hand-crafted or built in-process.
 */

import { describe, expect, test } from "bun:test"
import { deflateRawSync } from "node:zlib"
import { buildDocx, buildPptx, buildXlsx } from "@/tool/document/authoring"
import { crc32, type UnzipResult, unzip } from "@/tool/document/authoring/zip-store"
import { parseDocx } from "@/tool/document/docx-read"
import { parsePptx } from "@/tool/document/pptx-read"
import { parseXlsx } from "@/tool/document/xlsx-read"

/* ============================================================ byte helpers == */

const u16 = (n: number): Uint8Array => Uint8Array.from([n & 0xff, (n >>> 8) & 0xff])
const u32 = (n: number): Uint8Array =>
  Uint8Array.from([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff])
const cat = (...a: Uint8Array[]): Uint8Array => {
  const len = a.reduce((s, x) => s + x.length, 0)
  const out = new Uint8Array(len)
  let o = 0
  for (const x of a) {
    out.set(x, o)
    o += x.length
  }
  return out
}
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

const LOCAL_SIG = 0x04034b50
const CENTRAL_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50

// Little-endian readers (byte access defaults to 0 past the end — fine for the
// in-range offsets these tests use), kept assertion-free for biome cleanliness.
const at = (b: Uint8Array, i: number): number => b[i] ?? 0
const readU32Le = (b: Uint8Array, o: number): number =>
  (at(b, o) | (at(b, o + 1) << 8) | (at(b, o + 2) << 16) | (at(b, o + 3) << 24)) >>> 0
/** Locate the EOCD record by scanning backwards for its signature. -1 if absent. */
const findEocd = (b: Uint8Array): number => {
  for (let i = b.length - 22; i >= 0; i--) {
    if (readU32Le(b, i) === EOCD_SIG) return i
  }
  return -1
}
/** central-directory offset recorded in the EOCD (field at eocd+16). */
const centralOffsetOf = (b: Uint8Array, eocd: number): number => readU32Le(b, eocd + 16)
const flipByte = (b: Uint8Array, i: number): void => {
  b[i] = at(b, i) ^ 0xff
}

/**
 * Hand-craft a ONE-entry zip with FULL control over the CRC field and method,
 * so a test can declare a CRC that does NOT match the (decoded) payload — the
 * exact tamper a corrupt/malicious archive presents. `method` 0 = STORED (the
 * stored bytes ARE the payload), 8 = DEFLATE (payload is deflate-compressed).
 */
const craftZip = (opts: {
  name: string
  raw: Uint8Array
  method: 0 | 8
  /** CRC field written into BOTH headers. Defaults to the TRUE crc32(raw). */
  crc?: number
  /** Override the compressed-payload bytes (e.g. truncate to run past EOF). */
  payloadOverride?: Uint8Array
  /** Override the declared compSize in the headers (to point past EOF). */
  compSizeOverride?: number
}): Uint8Array => {
  const payload =
    opts.payloadOverride ?? (opts.method === 8 ? deflateRawSync(Buffer.from(opts.raw)) : opts.raw)
  const crc = opts.crc ?? crc32(opts.raw)
  const compSize = opts.compSizeOverride ?? payload.length
  const nm = utf8(opts.name)
  const local = cat(
    u32(LOCAL_SIG),
    u16(20),
    u16(0),
    u16(opts.method),
    u16(0),
    u16(0),
    u32(crc),
    u32(compSize),
    u32(opts.raw.length),
    u16(nm.length),
    u16(0),
    nm,
    new Uint8Array(payload),
  )
  const centralStart = local.length
  const central = cat(
    u32(CENTRAL_SIG),
    u16(20),
    u16(20),
    u16(0),
    u16(opts.method),
    u16(0),
    u16(0),
    u32(crc),
    u32(compSize),
    u32(opts.raw.length),
    u16(nm.length),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(0), // local header offset
    nm,
  )
  const eocd = cat(
    u32(EOCD_SIG),
    u16(0),
    u16(0),
    u16(1),
    u16(1),
    u32(central.length),
    u32(centralStart),
    u16(0),
  )
  return cat(local, central, eocd)
}

const expectFail = (r: UnzipResult): string => {
  expect(r.ok).toBe(false)
  if (r.ok) throw new Error("expected unzip failure")
  return r.error
}

/* ====================================== 1. CRC verification (the core fix) == */

describe("R2 zip-store unzip — CRC-32 verification (no silent corruption)", () => {
  test("STORED entry with a CORRUPTED CRC field → typed crc-mismatch, no silent data", () => {
    const raw = utf8("the real payload bytes")
    const truthful = crc32(raw)
    // Declare a CRC that does NOT match the payload (single-bit flip of the truth).
    const zip = craftZip({ name: "a.bin", raw, method: 0, crc: (truthful ^ 0x1) >>> 0 })
    const err = expectFail(unzip(zip))
    expect(err).toContain("CRC mismatch")
    // The wrong bytes were NOT returned as if valid.
  })

  test("DEFLATE entry whose PAYLOAD was tampered (CRC of inflated bytes won't match) → typed failure", () => {
    // Build a valid DEFLATE entry, then corrupt the deflate stream so it inflates
    // to DIFFERENT bytes while the declared CRC still claims the original.
    const raw = utf8("hello world ".repeat(64))
    const comp = deflateRawSync(Buffer.from(raw))
    const tampered = new Uint8Array(comp)
    // Flip a payload byte in the middle (still a decodable stream, different output).
    flipByte(tampered, Math.floor(tampered.length / 2))
    let r: UnzipResult
    try {
      r = unzip(
        craftZip({
          name: "b.bin",
          raw,
          method: 8,
          crc: crc32(raw), // truthful CRC of ORIGINAL — won't match tampered output
          payloadOverride: tampered,
        }),
      )
    } catch (e) {
      throw new Error(`unzip threw (must be no-throw): ${(e as Error).message}`)
    }
    // Either the deflate stream is now invalid (inflate failed) OR it inflates to
    // different bytes (CRC mismatch). BOTH are typed failures — never ok with
    // wrong data. We assert no-throw + ok:false.
    const err = expectFail(r)
    expect(err.includes("CRC mismatch") || err.includes("inflate failed")).toBe(true)
  })

  test("STORED entry with the TRUTHFUL CRC still unzips (fix did not break the happy path)", () => {
    const raw = utf8("untampered content")
    const r = unzip(craftZip({ name: "ok.bin", raw, method: 0 }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(new TextDecoder().decode(r.entries[0]?.data)).toBe("untampered content")
  })

  test("DEFLATE entry with the TRUTHFUL CRC still unzips + inflates correctly", () => {
    const raw = utf8("deflate me ".repeat(50))
    const r = unzip(craftZip({ name: "ok8.bin", raw, method: 8 }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(new TextDecoder().decode(r.entries[0]?.data)).toContain("deflate me")
  })
})

/* ============================== 2. VALID OOXML archives must NOT be rejected = */

describe("R2 zip-store — real serializer round-trip survives CRC verify", () => {
  test("buildXlsx → parseXlsx: cells round-trip unchanged (no false CRC rejection)", () => {
    const bytes = buildXlsx({
      sheets: [
        {
          name: "Data",
          rows: [
            ["id", "name"],
            ["1", "Ada"],
            ["2", "Bo"],
          ],
        },
      ],
    })
    // The container itself unzips cleanly (every entry's CRC verifies).
    expect(unzip(bytes).ok).toBe(true)
    const out = parseXlsx(bytes)
    expect(out.ok).toBe(true)
    const s = out.ok ? out.sheets[0] : undefined
    expect(s).toBeDefined()
    if (s !== undefined) {
      expect(s.cellAt(0, 0)).toBe("id")
      expect(s.cellAt(1, 1)).toBe("Ada")
      expect(s.cellAt(2, 1)).toBe("Bo")
    }
  })

  test("buildDocx → parseDocx: text round-trips unchanged", () => {
    const bytes = buildDocx({
      paragraphs: [
        { kind: "heading", level: 1, text: "Title" },
        { kind: "paragraph", runs: [{ text: "body line" }] },
      ],
    })
    expect(unzip(bytes).ok).toBe(true)
    const out = parseDocx(bytes)
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.text).toContain("Title")
      expect(out.text).toContain("body line")
    }
  })

  test("buildPptx → parsePptx: title + body round-trip unchanged", () => {
    const bytes = buildPptx({ slides: [{ title: "Deck", body: ["point a", "point b"] }] })
    expect(unzip(bytes).ok).toBe(true)
    const out = parsePptx(bytes)
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.text).toContain("Deck")
      expect(out.text).toContain("point a")
    }
  })

  test("CORRUPTING a real buildXlsx archive's central-directory CRC → parseXlsx fails (not wrong cells)", () => {
    const bytes = buildXlsx({ sheets: [{ name: "S", rows: [["secret", "42"]] }] })
    // Locate the EOCD → central offset, then flip the CRC of the FIRST central
    // record (CRC field is at central+16). This is exactly the on-disk tamper a
    // bit-rotted/edited file presents.
    const eocd = findEocd(bytes)
    expect(eocd).toBeGreaterThanOrEqual(0)
    const centralOffset = centralOffsetOf(bytes, eocd)
    const tampered = new Uint8Array(bytes)
    flipByte(tampered, centralOffset + 16)
    // unzip must reject; parseXlsx therefore reports malformed, NOT wrong cells.
    expect(unzip(tampered).ok).toBe(false)
    const out = parseXlsx(tampered)
    expect(out.ok).toBe(false)
  })
})

/* ============================== 3. structural attacks — typed failure no-throw */

describe("R2 zip-store unzip — structural corruption (no-throw typed failure)", () => {
  test("TRUNCATED central directory → typed failure, no throw", () => {
    const raw = utf8("x")
    const full = craftZip({ name: "t.bin", raw, method: 0 })
    // Lie in the EOCD: claim 5 entries but the central dir holds only 1, so the
    // walk runs off the end of the (truncated) directory.
    const tampered = new Uint8Array(full)
    const eocd = findEocd(tampered)
    // total-entries field is at eocd+10.
    tampered[eocd + 10] = 5
    tampered[eocd + 11] = 0
    let r: UnzipResult | undefined
    expect(() => {
      r = unzip(tampered)
    }).not.toThrow()
    expect(r).toBeDefined()
    if (r !== undefined) expectFail(r)
  })

  test("BAD EOCD signature (no EOCD at all) → typed failure", () => {
    const junk = new Uint8Array(64).fill(0x41) // 'A' × 64, no EOCD signature
    // No-throw by contract: a throw here fails the test directly.
    const err = expectFail(unzip(junk))
    expect(err).toContain("end-of-central-directory")
  })

  test("entry whose declared compSize runs PAST EOF → typed failure", () => {
    const raw = utf8("present")
    const zip = craftZip({
      name: "past.bin",
      raw,
      method: 0,
      compSizeOverride: 1 << 24, // 16 MiB declared, but the archive is tiny
    })
    const err = expectFail(unzip(zip))
    expect(err).toContain("past end of archive")
  })

  test("zip shorter than an EOCD record → typed failure (too small)", () => {
    const r = unzip(new Uint8Array(10))
    const err = expectFail(r)
    expect(err).toContain("too small")
  })
})

/* ============================== 4. OOXML reader robustness — garbage required part */

describe("R2 OOXML readers — valid container, garbage/missing required part", () => {
  test("xlsx_read on a valid zip whose xl/workbook.xml is GARBAGE → typed failure, no crash", () => {
    // A valid STORED container with a workbook.xml that is NOT valid workbook XML
    // (no <sheet> elements, no worksheets). parseXlsx must report ok:false, not throw.
    const garbage = utf8("<<not xml at all >>> &&& ]]>")
    const zip = craftZip({ name: "xl/workbook.xml", raw: garbage, method: 0 })
    // parseXlsx is no-throw by contract; a throw fails the test directly.
    expect(parseXlsx(zip).ok).toBe(false)
  })

  test("docx_read on a zip MISSING word/document.xml → typed failure, no crash", () => {
    const zip = craftZip({ name: "junk.txt", raw: utf8("hi"), method: 0 })
    expect(parseDocx(zip).ok).toBe(false)
  })

  test("pptx_read on a zip with NO slide parts → typed failure, no crash", () => {
    const zip = craftZip({ name: "ppt/presentation.xml", raw: utf8("<p/>"), method: 0 })
    expect(parsePptx(zip).ok).toBe(false)
  })

  test("docx_read on a CORRUPTED-CRC container surfaces the zip error (not garbage text)", () => {
    const bytes = buildDocx({ paragraphs: [{ kind: "paragraph", runs: [{ text: "real text" }] }] })
    const tampered = new Uint8Array(bytes)
    const eocd = findEocd(tampered)
    expect(eocd).toBeGreaterThanOrEqual(0)
    flipByte(tampered, centralOffsetOf(tampered, eocd) + 16)
    const out = parseDocx(tampered)
    expect(out.ok).toBe(false)
  })
})
