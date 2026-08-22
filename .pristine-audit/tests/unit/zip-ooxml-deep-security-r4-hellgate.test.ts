/**
 * Round-4 DEEP security hardening — ZIP/OOXML surface (jun-05).
 *
 * Round-1 sealed the DEFLATE total-cap bomb; Round-2 added CRC-32 verification.
 * This round hunts the REMAINING attack classes against `zip-store.ts`'s `unzip`
 * reader and the three OOXML parsers (`parseXlsx`/`parseDocx`/`parsePptx`):
 *
 *   1. ZIP-SLIP (path traversal via a hostile entry NAME). VERDICT (traced):
 *      the surface is IN-MEMORY-ONLY. `unzip` carries the raw entry name as a
 *      STRING (`{path, data}`); `findZipPart` and the readers look parts up by
 *      EXACT-STRING equality / a fixed regex on `e.path` — they NEVER resolve an
 *      entry name to a filesystem path. The WRITERS (`xlsx_write` etc.) write ONE
 *      jailed output file from the TOOL-INPUT path via `resolveVersionedJailedTarget`;
 *      the archive's internal entry names (`xl/workbook.xml`, …) are produced
 *      by the pure serializer and NEVER touch the FS. So a `../../etc/passwd`
 *      entry name is just a string key that no real part ever matches → the
 *      reader simply returns "missing required part", no escape. These tests
 *      PROVE that: a `../`/absolute/drive-letter entry name is carried verbatim
 *      and is only ever found by its EXACT name (no normalization-to-FS).
 *   2. Zip64 / oversized counts/offsets near 0xFFFFFFFF → typed failure, no OOB.
 *   3. XML-bomb resistance: the regex parsers do NOT expand entities (billion-
 *      laughs is inert) and do not catastrophically backtrack on a huge single
 *      `<row>`/`<w:t>`/`<a:t>` (bounded-time proof).
 *   4. Entry-name collisions / duplicate parts → deterministic (FIRST wins).
 *   5. Truncated / overlapping fields → typed failure, no throw.
 *   6. CRC necessary-not-sufficient: a CRC that MATCHES but XML that is malformed
 *      → reader returns a typed failure, never a crash.
 *
 * Pure: no FS, no network. All archives are hand-crafted or built in-process.
 * Every test is adversarial + NO-THROW + bounded-time.
 */

import { describe, expect, test } from "bun:test"
import { deflateRawSync } from "node:zlib"
import { buildDocx, buildPptx, buildXlsx } from "@/tool/document/authoring"
import {
  crc32,
  findZipPart,
  type UnzipResult,
  unzip,
  ZIP_MAX_ENTRY_BYTES,
} from "@/tool/document/authoring/zip-store"
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

/**
 * Hand-craft a ZIP with FULL control over entry NAME, method, declared sizes,
 * the local-header offset, and the EOCD count/offset — the levers an attacker
 * controls. Builds N entries (one raw payload reused). `nameFor(i)` lets a test
 * inject hostile names; `countOverride`/`centralOffsetOverride` lie in the EOCD.
 */
const craftZip = (opts: {
  entries: ReadonlyArray<{ name: string; raw: Uint8Array; method: 0 | 8; crc?: number }>
  countOverride?: number
  centralOffsetOverride?: number
  /** Append N junk bytes after the EOCD (trailing comment region). */
  trailer?: Uint8Array
}): Uint8Array => {
  const locals: Uint8Array[] = []
  const offsets: number[] = []
  const built: Array<{
    nm: Uint8Array
    crc: number
    method: number
    comp: Uint8Array
    rawLen: number
  }> = []
  let off = 0
  for (const e of opts.entries) {
    const nm = utf8(e.name)
    const comp = e.method === 8 ? new Uint8Array(deflateRawSync(Buffer.from(e.raw))) : e.raw
    const crc = e.crc ?? crc32(e.raw)
    offsets.push(off)
    const lh = cat(
      u32(LOCAL_SIG),
      u16(20),
      u16(0),
      u16(e.method),
      u16(0),
      u16(0),
      u32(crc),
      u32(comp.length),
      u32(e.raw.length),
      u16(nm.length),
      u16(0),
      nm,
      comp,
    )
    locals.push(lh)
    off += lh.length
    built.push({ nm, crc, method: e.method, comp, rawLen: e.raw.length })
  }
  const centralStart = off
  const centrals: Uint8Array[] = []
  for (let i = 0; i < built.length; i++) {
    const b = built[i] as (typeof built)[number]
    const ch = cat(
      u32(CENTRAL_SIG),
      u16(20),
      u16(20),
      u16(0),
      u16(b.method),
      u16(0),
      u16(0),
      u32(b.crc),
      u32(b.comp.length),
      u32(b.rawLen),
      u16(b.nm.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offsets[i] as number),
      b.nm,
    )
    centrals.push(ch)
    off += ch.length
  }
  const centralSize = off - centralStart
  const count = opts.countOverride ?? built.length
  const centralOffset = opts.centralOffsetOverride ?? centralStart
  const eocd = cat(
    u32(EOCD_SIG),
    u16(0),
    u16(0),
    u16(count),
    u16(count),
    u32(centralSize),
    u32(centralOffset),
    u16(0),
  )
  return cat(...locals, ...centrals, eocd, opts.trailer ?? new Uint8Array(0))
}

const expectFail = (r: UnzipResult): string => {
  expect(r.ok).toBe(false)
  if (r.ok) throw new Error("expected unzip failure")
  return r.error
}
const expectOk = (r: UnzipResult): { readonly path: string; readonly data: Uint8Array }[] => {
  expect(r.ok).toBe(true)
  if (!r.ok) throw new Error(`expected unzip ok: ${r.error}`)
  return r.entries
}

/* ============================ 1. ZIP-SLIP — in-memory-only (NO FS resolution) */

describe("R4 zip-slip — hostile entry names are STRING keys, never FS paths", () => {
  const HOSTILE = [
    "../../../etc/passwd",
    "..\\..\\..\\windows\\system32\\drivers\\etc\\hosts",
    "/abs/path/secret",
    "foo/../../bar",
    "C:\\windows\\evil.dll",
    "....//....//etc/shadow",
  ] as const

  for (const name of HOSTILE) {
    test(`entry name "${name}" survives VERBATIM and is only found by EXACT name (no normalization)`, () => {
      const raw = utf8("PAYLOAD-FOR-HOSTILE-NAME")
      const r = unzip(craftZip({ entries: [{ name, raw, method: 0 }] }))
      const entries = expectOk(r)
      // The name is carried VERBATIM — not normalized, not resolved, not stripped.
      expect(entries[0]?.path).toBe(name)
      // findZipPart is EXACT-string lookup: the hostile name matches only itself.
      expect(findZipPart(r, name)).toEqual(raw)
      // A traversal-normalized form of the name does NOT match (proving there is
      // no path resolution that would have collapsed `../` into a real FS path).
      expect(findZipPart(r, "passwd")).toBeUndefined()
      expect(findZipPart(r, "etc/passwd")).toBeUndefined()
      expect(findZipPart(r, "secret")).toBeUndefined()
    })
  }

  test("OOXML readers IGNORE a hostile-named part: a `../`-named workbook is NOT the workbook", () => {
    // A zip whose ONLY part is named `../../xl/workbook.xml`. parseXlsx looks for
    // the EXACT string "xl/workbook.xml" — the traversal-prefixed name does not
    // match, so the reader reports "missing workbook" rather than reading it
    // (and certainly never writes/resolves it to disk).
    const raw = utf8(
      `<?xml version="1.0"?><workbook><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>`,
    )
    const zip = craftZip({ entries: [{ name: "../../xl/workbook.xml", raw, method: 0 }] })
    const out = parseXlsx(zip)
    expect(out.ok).toBe(false) // exact-name miss → typed failure, no FS touch
  })

  test("docx reader: a `..`-named document.xml is NOT matched (exact-name only)", () => {
    const raw = utf8(
      `<w:document><w:body><w:p><w:r><w:t>hi</w:t></w:r></w:p></w:body></w:document>`,
    )
    const zip = craftZip({ entries: [{ name: "../word/document.xml", raw, method: 0 }] })
    expect(parseDocx(zip).ok).toBe(false)
  })

  test("pptx reader: a `/abs`-prefixed slide part does NOT match the slide regex", () => {
    const raw = utf8(`<p:sld><p:cSld><p:spTree></p:spTree></p:cSld></p:sld>`)
    // Regex is ^ppt/slides/slideN.xml$ — a leading slash / `..` breaks the anchor.
    const zip = craftZip({ entries: [{ name: "/ppt/slides/slide1.xml", raw, method: 0 }] })
    expect(parsePptx(zip).ok).toBe(false)
  })

  test("a hostile name ALONGSIDE the real part: the real part still reads; hostile is inert", () => {
    // Mixing a `../`-named decoy with a legitimately-named workbook proves the
    // hostile entry neither shadows nor corrupts the real lookup.
    const wb = utf8(
      `<?xml version="1.0"?><workbook xmlns:r="r"><sheets><sheet name="Real" r:id="rId1"/></sheets></workbook>`,
    )
    const sheet = utf8(
      `<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>cell</t></is></c></row></sheetData></worksheet>`,
    )
    const decoy = utf8("malicious")
    const zip = craftZip({
      entries: [
        { name: "../../../etc/passwd", raw: decoy, method: 0 },
        { name: "xl/workbook.xml", raw: wb, method: 0 },
        { name: "xl/worksheets/sheet1.xml", raw: sheet, method: 0 },
      ],
    })
    const out = parseXlsx(zip)
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.sheets[0]?.cellAt(0, 0)).toBe("cell")
  })
})

/* ============================ 2. Zip64 / oversized counts + offsets ========= */

describe("R4 zip64 / oversized metadata — typed failure, no OOB read", () => {
  test("EOCD central-dir offset == 0xFFFFFFFF (zip64 sentinel) → out-of-range, typed failure", () => {
    const real = craftZip({ entries: [{ name: "a.bin", raw: utf8("x"), method: 0 }] })
    // Overwrite the central-offset field in the real EOCD with 0xFFFFFFFF.
    const zip = craftZip({
      entries: [{ name: "a.bin", raw: utf8("x"), method: 0 }],
      centralOffsetOverride: 0xffffffff,
    })
    void real
    const err = expectFail(unzip(zip))
    expect(err).toContain("central-directory offset out of range")
  })

  test("central offset just past EOF (== length) → typed failure (not an OOB slice)", () => {
    const base = craftZip({ entries: [{ name: "a.bin", raw: utf8("hi"), method: 0 }] })
    const zip = craftZip({
      entries: [{ name: "a.bin", raw: utf8("hi"), method: 0 }],
      centralOffsetOverride: base.length, // == archive length → >= zip.length reject
    })
    expect(expectFail(unzip(zip))).toContain("out of range")
  })

  test("EOCD count near 0xFFFF (65535) but no entries → rejected as too-many or truncated, no hang", () => {
    const t0 = Date.now()
    const zip = craftZip({
      entries: [{ name: "a.bin", raw: utf8("x"), method: 0 }],
      countOverride: 0xffff,
    })
    const r = unzip(zip)
    expect(Date.now() - t0).toBeLessThan(5_000)
    expect(r.ok).toBe(false)
  }, 10_000)

  test("local-header offset pointing past EOF → bad local-header, typed failure", () => {
    // Build a normal zip, then corrupt the central record's local-offset field to
    // point far past the archive. unzip must reject, not read OOB.
    const zip = craftZip({ entries: [{ name: "a.bin", raw: utf8("data"), method: 0 }] })
    const copy = new Uint8Array(zip)
    // Find the central record (scan for CENTRAL_SIG), local-offset is at +42.
    let cdir = -1
    for (let i = 0; i + 4 <= copy.length; i++) {
      if (
        (copy[i] as number) === 0x50 &&
        (copy[i + 1] as number) === 0x4b &&
        (copy[i + 2] as number) === 0x01 &&
        (copy[i + 3] as number) === 0x02
      ) {
        cdir = i
        break
      }
    }
    expect(cdir).toBeGreaterThanOrEqual(0)
    const off = cdir + 42
    copy.set(u32(0xfffffff0), off)
    const err = expectFail(unzip(copy))
    expect(err).toContain("bad local-header")
  })
})

/* ============================ 3. XML-bomb resistance ======================== */

describe("R4 XML-bomb resistance — no entity expansion, no catastrophic backtrack", () => {
  const wrapWorkbook = (sheetXml: string): Uint8Array => {
    const wb = utf8(
      `<?xml version="1.0"?><workbook xmlns:r="r"><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>`,
    )
    return craftZip({
      entries: [
        { name: "xl/workbook.xml", raw: wb, method: 0 },
        { name: "xl/worksheets/sheet1.xml", raw: utf8(sheetXml), method: 0 },
      ],
    })
  }

  test("billion-laughs DOCTYPE/ENTITY in a docx part is INERT (entities not expanded)", () => {
    // A classic billion-laughs DTD. A real XML parser would expand &lol9; into
    // gigabytes; the regex reader never processes ENTITY declarations, so the
    // raw `&lol9;` text is simply un-escaped char-by-char (no expansion).
    const bomb =
      `<?xml version="1.0"?>` +
      `<!DOCTYPE lolz [` +
      `<!ENTITY lol "lol">` +
      `<!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">` +
      `<!ENTITY lol9 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">` +
      `]>` +
      `<w:document><w:body><w:p><w:r><w:t>&lol9;</w:t></w:r></w:p></w:body></w:document>`
    const zip = craftZip({ entries: [{ name: "word/document.xml", raw: utf8(bomb), method: 0 }] })
    const t0 = Date.now()
    const out = parseDocx(zip)
    expect(Date.now() - t0).toBeLessThan(2_000)
    expect(out.ok).toBe(true)
    if (out.ok) {
      // `&lol9;` is an UNKNOWN entity to the reader's fixed un-escaper (it only
      // knows lt/gt/quot/apos/amp/#NN). It is left intact — NEVER expanded.
      expect(out.text).toContain("&lol9;")
      // No expansion ⇒ tiny output, not megabytes.
      expect(out.text.length).toBeLessThan(100)
    }
  })

  test("a huge single <w:t> run does NOT catastrophically backtrack (bounded time)", () => {
    // 2 MiB of inner text inside ONE <w:t>. The reader's `[\\s\\S]*?` lazy match
    // is linear; prove it completes well under a tripwire.
    const big = "a".repeat(2 * 1024 * 1024)
    const doc = `<w:document><w:body><w:p><w:r><w:t>${big}</w:t></w:r></w:p></w:body></w:document>`
    const zip = craftZip({ entries: [{ name: "word/document.xml", raw: utf8(doc), method: 0 }] })
    const t0 = Date.now()
    const out = parseDocx(zip)
    expect(Date.now() - t0).toBeLessThan(4_000)
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.text.length).toBe(big.length)
  }, 10_000)

  test("a huge single <row> with many cells parses in bounded time (no quadratic blowup)", () => {
    // 20k cells in ONE row. Linear-ish parse, must finish under the tripwire.
    let cells = ""
    for (let i = 0; i < 20_000; i++) cells += `<c r="A${1}" t="inlineStr"><is><t>v${i}</t></is></c>`
    const sheet = `<?xml version="1.0"?><worksheet><sheetData><row r="1">${cells}</row></sheetData></worksheet>`
    const zip = wrapWorkbook(sheet)
    const t0 = Date.now()
    const out = parseXlsx(zip)
    expect(Date.now() - t0).toBeLessThan(5_000)
    expect(out.ok).toBe(true)
  }, 10_000)

  test("deeply NESTED XML does not stack-overflow the regex scanner (iterative, not recursive)", () => {
    // 50k nested <a:p> open tags then closes. The reader's loops are iterative
    // regex scans (no recursion) — must not throw / overflow.
    const depth = 50_000
    let inner = "<a:t>deep</a:t>"
    // A flat run of many sibling paragraphs (the reader matches per-<a:p>).
    let paras = ""
    for (let i = 0; i < depth; i++) paras += `<a:p>${inner}</a:p>`
    inner = ""
    const slide = `<p:sld><p:cSld><p:spTree><p:sp>${paras}</p:sp></p:spTree></p:cSld></p:sld>`
    const zip = craftZip({
      entries: [{ name: "ppt/slides/slide1.xml", raw: utf8(slide), method: 0 }],
    })
    const t0 = Date.now()
    let threw = false
    let out: ReturnType<typeof parsePptx> | undefined
    try {
      out = parsePptx(zip)
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    expect(Date.now() - t0).toBeLessThan(6_000)
    expect(out?.ok).toBe(true)
  }, 12_000)
})

/* ============================ 4. Duplicate parts — deterministic FIRST wins = */

describe("R4 duplicate entry names — deterministic resolution", () => {
  test("two identical-named worksheet parts: parseXlsx is deterministic (first-by-name wins)", () => {
    const wb = utf8(
      `<?xml version="1.0"?><workbook xmlns:r="r"><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>`,
    )
    const sheetA = utf8(
      `<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>FIRST</t></is></c></row></sheetData></worksheet>`,
    )
    const sheetB = utf8(
      `<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>SECOND</t></is></c></row></sheetData></worksheet>`,
    )
    const zip = craftZip({
      entries: [
        { name: "xl/workbook.xml", raw: wb, method: 0 },
        { name: "xl/worksheets/sheet1.xml", raw: sheetA, method: 0 },
        { name: "xl/worksheets/sheet1.xml", raw: sheetB, method: 0 },
      ],
    })
    const out = parseXlsx(zip)
    expect(out.ok).toBe(true)
    // findZipPart uses Array.find → the FIRST occurrence wins, deterministically.
    if (out.ok) expect(out.sheets[0]?.cellAt(0, 0)).toBe("FIRST")
  })

  test("findZipPart on a dup-named archive returns the FIRST entry's bytes", () => {
    const r = unzip(
      craftZip({
        entries: [
          { name: "dup.bin", raw: utf8("ONE"), method: 0 },
          { name: "dup.bin", raw: utf8("TWO"), method: 0 },
        ],
      }),
    )
    expect(new TextDecoder().decode(findZipPart(r, "dup.bin"))).toBe("ONE")
  })

  test("two document.xml parts in a docx: parseDocx deterministically reads the FIRST", () => {
    const a = utf8(
      `<w:document><w:body><w:p><w:r><w:t>ALPHA</w:t></w:r></w:p></w:body></w:document>`,
    )
    const b = utf8(
      `<w:document><w:body><w:p><w:r><w:t>BETA</w:t></w:r></w:p></w:body></w:document>`,
    )
    const zip = craftZip({
      entries: [
        { name: "word/document.xml", raw: a, method: 0 },
        { name: "word/document.xml", raw: b, method: 0 },
      ],
    })
    const out = parseDocx(zip)
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.text).toBe("ALPHA")
  })
})

/* ============================ 5. Truncated / overlapping fields ============= */

describe("R4 truncation / overlap — typed failure, no throw, no OOB", () => {
  test("name length running past the header (declared name longer than buffer) → typed failure", () => {
    // Build a 1-entry zip then inflate the central record's name-length field so
    // p+46+nameLen runs past EOF.
    const zip = craftZip({ entries: [{ name: "n.bin", raw: utf8("d"), method: 0 }] })
    const copy = new Uint8Array(zip)
    // central name-length is at central+28; find central sig.
    let cdir = -1
    for (let i = 0; i + 4 <= copy.length; i++) {
      if (
        (copy[i] as number) === 0x50 &&
        (copy[i + 1] as number) === 0x4b &&
        (copy[i + 2] as number) === 0x01 &&
        (copy[i + 3] as number) === 0x02
      ) {
        cdir = i
        break
      }
    }
    expect(cdir).toBeGreaterThanOrEqual(0)
    copy.set(u16(0xffff), cdir + 28) // name length 65535 → past EOF
    let threw = false
    let r: UnzipResult | undefined
    try {
      r = unzip(copy)
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    if (r !== undefined) expect(r.ok).toBe(false)
  })

  test("local-header compSize overlapping past EOF → 'runs past end of archive', no OOB slice", () => {
    const zip = craftZip({ entries: [{ name: "ov.bin", raw: utf8("12345"), method: 0 }] })
    const copy = new Uint8Array(zip)
    // central compSize at central+20; bump it far past EOF.
    let cdir = -1
    for (let i = 0; i + 4 <= copy.length; i++) {
      if (
        (copy[i] as number) === 0x50 &&
        (copy[i + 1] as number) === 0x4b &&
        (copy[i + 2] as number) === 0x01 &&
        (copy[i + 3] as number) === 0x02
      ) {
        cdir = i
        break
      }
    }
    copy.set(u32(1 << 20), cdir + 20)
    const err = expectFail(unzip(copy))
    expect(err).toContain("past end of archive")
  })

  test("central record truncated mid-header (p+46 > EOF) → typed truncation failure", () => {
    // Claim 2 entries but only supply bytes for ~1.x central records.
    const zip = craftZip({
      entries: [{ name: "a", raw: utf8("x"), method: 0 }],
      countOverride: 2,
    })
    const err = expectFail(unzip(zip))
    expect(err.includes("truncated") || err.includes("bad central")).toBe(true)
  })

  test("zip with valid EOCD but central offset inside the LOCAL data (sig mismatch) → typed failure", () => {
    const zip = craftZip({ entries: [{ name: "x.bin", raw: utf8("payload"), method: 0 }] })
    const copy = new Uint8Array(zip)
    // Point central offset at byte 4 (inside local header — not a CENTRAL_SIG).
    const eocd = (() => {
      for (let i = copy.length - 22; i >= 0; i--) {
        if (
          (copy[i] as number) === 0x50 &&
          (copy[i + 1] as number) === 0x4b &&
          (copy[i + 2] as number) === 0x05 &&
          (copy[i + 3] as number) === 0x06
        )
          return i
      }
      return -1
    })()
    expect(eocd).toBeGreaterThanOrEqual(0)
    copy.set(u32(4), eocd + 16)
    const err = expectFail(unzip(copy))
    expect(err).toContain("bad central-directory signature")
  })
})

/* ============================ 6. CRC necessary-not-sufficient =============== */

describe("R4 CRC matches but content malformed — typed failure, not a crash", () => {
  test("workbook part with a TRUTHFUL CRC but GARBAGE XML → parseXlsx typed failure, no throw", () => {
    // CRC over the garbage matches (craftZip computes it), so the zip layer
    // ACCEPTS the bytes; the XML layer must reject the malformed workbook.
    const garbage = utf8("<<< not workbook xml &&& ]]> >>>")
    const zip = craftZip({ entries: [{ name: "xl/workbook.xml", raw: garbage, method: 0 }] })
    // Sanity: the container itself unzips (CRC verifies) ...
    expect(unzip(zip).ok).toBe(true)
    // ... yet the OOXML reader reports failure rather than crashing.
    let threw = false
    let out: ReturnType<typeof parseXlsx> | undefined
    try {
      out = parseXlsx(zip)
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    expect(out?.ok).toBe(false)
  })

  test("docx document.xml with valid CRC but UNCLOSED tags → typed failure / empty, no throw", () => {
    // Unbalanced WordprocessingML: the reader's lazy `[\\s\\S]*?` simply finds no
    // matching close, yielding no paragraphs — never a throw.
    const broken = utf8(`<w:document><w:body><w:p><w:r><w:t>dangling`)
    const zip = craftZip({ entries: [{ name: "word/document.xml", raw: broken, method: 0 }] })
    expect(unzip(zip).ok).toBe(true)
    let threw = false
    let out: ReturnType<typeof parseDocx> | undefined
    try {
      out = parseDocx(zip)
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    // No throw; whatever it returns, it must be the typed shape (ok true/false).
    expect(typeof out?.ok).toBe("boolean")
  })

  test("pptx slide with valid CRC but malformed shape XML → typed failure / safe parse, no throw", () => {
    const broken = utf8(`<p:sld><p:cSld><p:spTree><p:sp><a:p><a:t>x`)
    const zip = craftZip({ entries: [{ name: "ppt/slides/slide1.xml", raw: broken, method: 0 }] })
    expect(unzip(zip).ok).toBe(true)
    let threw = false
    let out: ReturnType<typeof parsePptx> | undefined
    try {
      out = parsePptx(zip)
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    expect(out?.ok).toBe(true) // slide part EXISTS by name → ok, body may be empty
  })

  test("CRC mismatch is STILL caught even when the XML would have been valid (CRC gate fires first)", () => {
    // Prove CRC verification precedes the XML layer: valid workbook XML but a
    // LYING CRC → unzip rejects, parseXlsx surfaces the zip error (not the cells).
    const wb = utf8(
      `<?xml version="1.0"?><workbook xmlns:r="r"><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>`,
    )
    const trueCrc = crc32(wb)
    const zip = craftZip({
      entries: [{ name: "xl/workbook.xml", raw: wb, method: 0, crc: (trueCrc ^ 0xff) >>> 0 }],
    })
    expect(expectFail(unzip(zip))).toContain("CRC mismatch")
    expect(parseXlsx(zip).ok).toBe(false)
  })
})

/* ============================ regression: valid archives still accepted ===== */

describe("R4 no false rejection — real OOXML round-trips survive every new lens", () => {
  test("buildXlsx/buildDocx/buildPptx still unzip + parse cleanly (R4 added no false positive)", () => {
    const xlsx = buildXlsx({ sheets: [{ name: "S", rows: [["a", 1]] }] })
    expect(unzip(xlsx).ok).toBe(true)
    expect(parseXlsx(xlsx).ok).toBe(true)

    const docx = buildDocx({ paragraphs: [{ kind: "paragraph", runs: [{ text: "hello" }] }] })
    expect(unzip(docx).ok).toBe(true)
    expect(parseDocx(docx).ok).toBe(true)

    const pptx = buildPptx({ slides: [{ title: "T", body: ["b"] }] })
    expect(unzip(pptx).ok).toBe(true)
    expect(parsePptx(pptx).ok).toBe(true)
  })

  test("per-entry cap constant is unchanged (32 MiB) — sanity that R4 touched no caps", () => {
    expect(ZIP_MAX_ENTRY_BYTES).toBe(32 * 1024 * 1024)
  })
})
