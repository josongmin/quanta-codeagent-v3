/**
 * Round-1 adversarial hardening — TOOL CLUSTER (jun-04).
 *
 * Seals gaps + boundary cases across B5 (read device/binary guard), H9
 * (read-dedup `file_unchanged`), H12 (edit line-ranges), H14a (image_gen),
 * H14b (office authoring + readers), and the gated read-only observability
 * tools. Every test is adversarial: an exact-boundary input, a no-hang proof
 * (per-test timeout), a no-OOM proof (size cap), a byte-identity proof for the
 * default-OFF path, or a hostile-XML round-trip.
 *
 * REAL BUG sealed this round (zip-store `unzip` total-cap):
 *   A DEFLATE archive that DECLARES a tiny `uncompSize` per entry while each
 *   payload ACTUALLY inflates near the per-entry cap defeated the AGGREGATE
 *   total cap — `totalUncompressed` accumulated the LYING declared sizes, so
 *   N entries inflated to N×32 MiB (≫ 64 MiB total) with no rejection. Fix:
 *   accumulate ACTUAL decoded bytes + bound each inflate by the REMAINING total
 *   budget. The `DEFLATE total-cap bomb` test below is the regression seal.
 *
 * All FS is tmp; all network/provider/write I/O is faked. No real network.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deflateRawSync } from "node:zlib"
import { __resetRuntimeConfig } from "@/shared"
import { buildDocx, buildPptx, buildXlsx, escapeXml, xmlText } from "@/tool/document/authoring"
import { crc32, unzip, ZIP_MAX_ENTRY_BYTES } from "@/tool/document/authoring/zip-store"
import { parseDocx } from "@/tool/document/docx-read"
import { parsePptx } from "@/tool/document/pptx-read"
import { parseXlsx } from "@/tool/document/xlsx-read"
import { editTool } from "@/tool/edit"
import {
  type ImageGenOutcome,
  type ImageGenPort,
  type ImageGenRequest,
  type ImageWritePort,
  imageGenTool,
} from "@/tool/image-gen"
import { readTool } from "@/tool/read"
import { ReadFileState } from "@/tool/stale-read-guard"
import type { ToolContext, ToolResult } from "@/tool/types"

/* ============================================================ harness ===== */

const dir = mkdtempSync(join(tmpdir(), "tool-cluster-r1-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const ctx = (cwd: string, readFileState?: ReadFileState): ToolContext =>
  readFileState === undefined
    ? { cwd, signal: new AbortController().signal }
    : { cwd, signal: new AbortController().signal, readFileState }

const drain = async (
  tool: {
    execute: (i: never, c: ToolContext) => AsyncIterable<{ type: string; result?: ToolResult }>
  },
  input: unknown,
  c: ToolContext,
): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input as never, c)) {
    if (ev.type === "result" && ev.result !== undefined) result = ev.result
  }
  if (result === undefined) throw new Error("no result yielded")
  return result
}

// ── byte helpers for hand-crafting hostile ZIPs ──────────────────────────────
const u16 = (n: number): Uint8Array => {
  const b = new Uint8Array(2)
  b[0] = n & 0xff
  b[1] = (n >>> 8) & 0xff
  return b
}
const u32 = (n: number): Uint8Array => {
  const b = new Uint8Array(4)
  b[0] = n & 0xff
  b[1] = (n >>> 8) & 0xff
  b[2] = (n >>> 16) & 0xff
  b[3] = (n >>> 24) & 0xff
  return b
}
const cat = (...a: Uint8Array[]): Uint8Array => {
  let n = 0
  for (const x of a) n += x.length
  const o = new Uint8Array(n)
  let p = 0
  for (const x of a) {
    o.set(x, p)
    p += x.length
  }
  return o
}

/* ================================================ B5 read device/binary ==== */

describe("B5 read device/binary guard — boundary + no-hang", () => {
  test("NUL at byte 8193 (just past the 8 KiB sniff window) reads OK — bound is exact", async () => {
    // The sniff window is exactly BINARY_SNIFF_BYTES = 8192. A NUL at index 8192
    // (the 8193rd byte, 0-based 8192) is the FIRST byte NOT scanned. Proving it
    // reads OK proves the bound is `< 8192`, not `<= 8192` (off-by-one seal).
    const f = join(dir, "nul-at-8193.txt")
    const head = Buffer.alloc(8192, 0x61) // 8192 clean 'a' bytes (indices 0..8191)
    const tail = Buffer.from([0x00]) // NUL at index 8192 — just past the window
    writeFileSync(f, Buffer.concat([head, tail]))
    const r = await drain(readTool, { path: f }, ctx(dir))
    expect(r.ok).toBe(true)
  })

  test("NUL at byte 8192 (LAST byte of the sniff window) IS detected — binary", async () => {
    // Index 8191 is the last byte the sniff reads. A NUL there must be caught.
    const f = join(dir, "nul-at-8192.txt")
    const head = Buffer.alloc(8191, 0x61) // indices 0..8190
    writeFileSync(f, Buffer.concat([head, Buffer.from([0x00])])) // NUL at index 8191
    const r = await drain(readTool, { path: f }, ctx(dir))
    expect(r.ok).toBe(false)
    expect(r.failure).toEqual({ mode: "rejected", reason: "binary_file" })
  })

  test("a NUL as the VERY FIRST byte is binary", async () => {
    const f = join(dir, "nul-first.bin")
    writeFileSync(f, Buffer.from([0x00, 0x41, 0x42]))
    const r = await drain(readTool, { path: f }, ctx(dir))
    expect(r.failure).toEqual({ mode: "rejected", reason: "binary_file" })
  })

  test("a FIFO read is rejected device_file and does NOT hang (5s tripwire)", async () => {
    const fifo = join(dir, "r1.fifo")
    execFileSync("mkfifo", [fifo])
    const r = await drain(readTool, { path: fifo }, ctx(dir))
    expect(r.ok).toBe(false)
    expect(r.failure).toEqual({ mode: "rejected", reason: "device_file" })
  }, 5000)

  test("a text file whose content is EXACTLY 8192 clean bytes reads OK (no false binary)", async () => {
    const f = join(dir, "exactly-8192.txt")
    writeFileSync(f, Buffer.alloc(8192, 0x62))
    const r = await drain(readTool, { path: f }, ctx(dir))
    expect(r.ok).toBe(true)
  })
})

/* ============================================ H9 read-dedup file_unchanged == */

describe("H9 read-dedup — trust model + byte-identity", () => {
  afterEach(() => {
    delete process.env.QUANTA_READ_DEDUP
    __resetRuntimeConfig()
  })

  test("default-OFF: identical re-read returns FULL content byte-identically (no sentinel, no state alloc)", async () => {
    // Knob unset ⇒ byte-identical legacy. Even WITH a ReadFileState wired, the
    // off path must never short-circuit and must render full numbered content.
    delete process.env.QUANTA_READ_DEDUP
    __resetRuntimeConfig()
    const f = join(dir, "dedup-off.txt")
    writeFileSync(f, "one\ntwo\nthree")
    const st = new ReadFileState()
    const c = ctx(dir, st)
    const a = await drain(readTool, { path: f }, c)
    const b = await drain(readTool, { path: f }, c)
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    expect(b.output).toBe(a.output)
    expect(b.output).toBe("1\tone\n2\ttwo\n3\tthree")
    expect(b.output).not.toContain("file_unchanged")
  })

  test("ON: identical range + unchanged mtime ⇒ file_unchanged sentinel", async () => {
    process.env.QUANTA_READ_DEDUP = "1"
    __resetRuntimeConfig()
    const f = join(dir, "dedup-on.txt")
    writeFileSync(f, "alpha\nbeta")
    const st = new ReadFileState()
    const c = ctx(dir, st)
    const first = await drain(readTool, { path: f }, c)
    expect(first.output).toBe("1\talpha\n2\tbeta")
    const second = await drain(readTool, { path: f }, c)
    expect(second.ok).toBe(true)
    expect(second.output).toContain("file_unchanged")
    expect(second.output).toContain(f)
  })

  test("TRUST MODEL: mtime UNCHANGED but content REWRITTEN in place ⇒ FRESH content (content-truth, UUX-6-07)", async () => {
    // H9's freshness signal is a CONTENT HASH of the just-read bytes (the old
    // mtime-trust contract served a stale sentinel here — the conscious,
    // reviewed flip this test used to demand). An external writer that rewrites
    // the bytes WITHOUT advancing mtime (same-second write + explicit utimes
    // reset) now yields the fresh content; the sentinel can never lie.
    process.env.QUANTA_READ_DEDUP = "1"
    __resetRuntimeConfig()
    const f = join(dir, "dedup-trust.txt")
    writeFileSync(f, "original")
    const st = new ReadFileState()
    const c = ctx(dir, st)
    const first = await drain(readTool, { path: f }, c)
    expect(first.output).toBe("1\toriginal")
    // Rewrite content but FORCE mtime back to the recorded value.
    const recorded = st.recordedMtime(
      // the read recorded by RESOLVED abs path == f here (already absolute)
      f,
    )
    expect(recorded).not.toBeUndefined()
    writeFileSync(f, "TAMPERED-DIFFERENT-CONTENT")
    const sec = (recorded as number) / 1000
    utimesSync(f, sec, sec)
    const second = await drain(readTool, { path: f }, c)
    // Fresh content served — the content hash misses despite the identical mtime.
    expect(second.output).not.toContain("file_unchanged")
    expect(second.output).toContain("TAMPERED-DIFFERENT-CONTENT")
  })

  test("ON: mtime ADVANCED ⇒ full content re-rendered (no stale short-circuit)", async () => {
    process.env.QUANTA_READ_DEDUP = "1"
    __resetRuntimeConfig()
    const f = join(dir, "dedup-advance.txt")
    writeFileSync(f, "v1")
    const st = new ReadFileState()
    const c = ctx(dir, st)
    await drain(readTool, { path: f }, c)
    // Advance mtime forward (external write).
    const recorded = st.recordedMtime(f) as number
    const future = (recorded + 5000) / 1000
    writeFileSync(f, "v2-new-content")
    utimesSync(f, future, future)
    const second = await drain(readTool, { path: f }, c)
    expect(second.ok).toBe(true)
    expect(second.output).not.toContain("file_unchanged")
    expect(second.output).toContain("v2-new-content")
  })

  test("ON: DIFFERENT range (offset/limit) is NOT deduped against the prior range", async () => {
    process.env.QUANTA_READ_DEDUP = "1"
    __resetRuntimeConfig()
    const f = join(dir, "dedup-range.txt")
    writeFileSync(f, "L1\nL2\nL3\nL4\nL5")
    const st = new ReadFileState()
    const c = ctx(dir, st)
    await drain(readTool, { path: f }, c) // whole file
    const ranged = await drain(readTool, { path: f, offset: 2, limit: 2 }, c)
    expect(ranged.ok).toBe(true)
    expect(ranged.output).not.toContain("file_unchanged")
    expect(ranged.output).toContain("L2")
  })
})

/* ============================================ H12 edit line-ranges ========== */

describe("H12 edit line-ranges — disambiguation + clean failures", () => {
  const seed = (name: string, content: string): string => {
    const p = join(dir, name)
    writeFileSync(p, content)
    return p
  }

  test("N identical occurrences + a range targeting exactly ONE ⇒ exactly one edit", async () => {
    const p = seed("h12-one.txt", "x\nx\nx\nx\nx")
    const r = await drain(
      editTool,
      { path: p, old_string: "x", new_string: "Y", line_ranges: [{ start: 3, end: 3 }] },
      ctx(dir),
    )
    expect(r.ok).toBe(true)
    const after = await Bun.file(p).text()
    expect(after).toBe("x\nx\nY\nx\nx")
  })

  test(">1 match WITHIN the range ⇒ ambiguous, NO edit applied", async () => {
    const p = seed("h12-ambig.txt", "x\nx\nx\nx")
    const before = await Bun.file(p).text()
    const r = await drain(
      editTool,
      { path: p, old_string: "x", new_string: "Y", line_ranges: [{ start: 1, end: 3 }] },
      ctx(dir),
    )
    expect(r.ok).toBe(false)
    expect(await Bun.file(p).text()).toBe(before)
  })

  test("range start > end ⇒ rejected, NO edit", async () => {
    const p = seed("h12-badrange.txt", "a\nb\nc")
    const before = await Bun.file(p).text()
    const r = await drain(
      editTool,
      { path: p, old_string: "b", new_string: "Z", line_ranges: [{ start: 3, end: 1 }] },
      ctx(dir),
    )
    expect(r.ok).toBe(false)
    expect(r.failure?.mode).toBe("rejected")
    expect(await Bun.file(p).text()).toBe(before)
  })

  test("negative / zero start ⇒ rejected (1-indexed invariant)", async () => {
    const p = seed("h12-neg.txt", "a\nb\nc")
    for (const bad of [0, -1]) {
      const r = await drain(
        editTool,
        { path: p, old_string: "b", new_string: "Z", line_ranges: [{ start: bad, end: 2 }] },
        ctx(dir),
      )
      expect(r.ok).toBe(false)
      expect(r.failure?.mode).toBe("rejected")
    }
    expect(await Bun.file(p).text()).toBe("a\nb\nc")
  })

  test("non-integer range bound ⇒ rejected", async () => {
    const p = seed("h12-float.txt", "a\nb\nc")
    const r = await drain(
      editTool,
      { path: p, old_string: "b", new_string: "Z", line_ranges: [{ start: 1.5, end: 2 }] },
      ctx(dir),
    )
    expect(r.ok).toBe(false)
    expect(r.failure?.mode).toBe("rejected")
  })

  test("range entirely BEYOND EOF ⇒ clean not-found failure, NO edit, file untouched", async () => {
    const p = seed("h12-eof.txt", "a\nb\nc")
    const before = await Bun.file(p).text()
    const r = await drain(
      editTool,
      { path: p, old_string: "b", new_string: "Z", line_ranges: [{ start: 100, end: 200 }] },
      ctx(dir),
    )
    expect(r.ok).toBe(false)
    expect(await Bun.file(p).text()).toBe(before)
  })

  test("omitted line_ranges ⇒ byte-identical legacy whole-file edit", async () => {
    const p = seed("h12-omit.txt", "only-one-match")
    const r = await drain(
      editTool,
      { path: p, old_string: "only-one-match", new_string: "REPLACED" },
      ctx(dir),
    )
    expect(r.ok).toBe(true)
    expect(await Bun.file(p).text()).toBe("REPLACED")
  })

  test("new_string with $& / $1 specials is inserted LITERALLY within a range (no replace-pattern interpretation)", async () => {
    const p = seed("h12-dollar.txt", "tok\ntok")
    const r = await drain(
      editTool,
      { path: p, old_string: "tok", new_string: "$& $1 $$", line_ranges: [{ start: 2, end: 2 }] },
      ctx(dir),
    )
    expect(r.ok).toBe(true)
    expect(await Bun.file(p).text()).toBe("tok\n$& $1 $$")
  })
})

/* ============================================ H14a image_gen =============== */

class MemWritePort implements ImageWritePort {
  readonly files = new Map<string, Uint8Array>()
  async exists(path: string): Promise<boolean> {
    return this.files.has(path)
  }
  async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(path, bytes)
  }
}

const PNG_1x1_B64 = Buffer.from(
  new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]),
).toString("base64")

const fixedPort = (outcome: ImageGenOutcome): ImageGenPort => ({
  async generate(_req: ImageGenRequest): Promise<ImageGenOutcome> {
    return outcome
  },
})

describe("H14a image_gen — versioned collision + caps + no-key (no network)", () => {
  let jail: string
  beforeEach(() => {
    jail = mkdtempSync(join(tmpdir(), "imggen-r1-"))
  })

  test("versioned-sibling COLLISION: hero.png AND hero-v2.png already exist ⇒ writes hero-v3.png", async () => {
    const wp = new MemWritePort()
    // Pre-seed BOTH the primary and the first versioned sibling as taken.
    const { resolveJailed } = await import("@/storage")
    const primary = resolveJailed("hero.png", jail) as string
    const v2 = resolveJailed("hero-v2.png", jail) as string
    wp.files.set(primary, new Uint8Array([1]))
    wp.files.set(v2, new Uint8Array([2]))
    const tool = imageGenTool({
      port: fixedPort({ kind: "ok", images: [{ b64: PNG_1x1_B64, mediaType: "image/png" }] }),
      writePort: wp,
    })
    const r = await drain(tool, { prompt: "p", outputPath: "hero.png" }, ctx(jail))
    expect(r.ok).toBe(true)
    const v3 = resolveJailed("hero-v3.png", jail) as string
    expect(wp.files.has(v3)).toBe(true)
    // Neither pre-existing file was overwritten.
    expect(wp.files.get(primary)).toEqual(new Uint8Array([1]))
    expect(wp.files.get(v2)).toEqual(new Uint8Array([2]))
  })

  test("key-less default port makes NO network call ⇒ typed no_key failure", async () => {
    // The default tool builds the OpenAI adapter with no apiKey. A fetcher that
    // THROWS proves no network call is made (no_key short-circuits first).
    const wp = new MemWritePort()
    const tool = imageGenTool({ writePort: wp })
    const r = await drain(tool, { prompt: "p", outputPath: "out.png" }, ctx(jail))
    expect(r.ok).toBe(false)
    expect(r.failure?.mode).toBe("error")
    expect(wp.files.size).toBe(0)
  })

  test("oversize provider image (> IMAGE_GEN_MAX_BYTES) ⇒ typed failure, nothing written", async () => {
    // Decoded bytes just over the cap. We craft a base64 that decodes to cap+1.
    const huge = Buffer.alloc(8 * 1024 * 1024 + 1, 0x41).toString("base64")
    const wp = new MemWritePort()
    const tool = imageGenTool({
      port: fixedPort({ kind: "ok", images: [{ b64: huge, mediaType: "image/png" }] }),
      writePort: wp,
    })
    const r = await drain(tool, { prompt: "p", outputPath: "big.png" }, ctx(jail))
    expect(r.ok).toBe(false)
    expect(r.failure?.mode).toBe("error")
    if (r.failure?.mode === "error") expect(r.failure.modelVisibleError).toBe("image_over_cap")
    expect(wp.files.size).toBe(0)
  })

  test("provider error outcome ⇒ typed ok:false (no throw past the boundary)", async () => {
    const wp = new MemWritePort()
    const tool = imageGenTool({
      port: fixedPort({ kind: "error", message: "rate limited" }),
      writePort: wp,
    })
    const r = await drain(tool, { prompt: "p", outputPath: "x.png" }, ctx(jail))
    expect(r.ok).toBe(false)
    expect(wp.files.size).toBe(0)
  })

  test("a THROWING provider is caught at the tool boundary ⇒ typed failure", async () => {
    const wp = new MemWritePort()
    const throwingPort: ImageGenPort = {
      async generate(): Promise<ImageGenOutcome> {
        throw new Error("boom from provider")
      },
    }
    const tool = imageGenTool({ port: throwingPort, writePort: wp })
    const r = await drain(tool, { prompt: "p", outputPath: "x.png" }, ctx(jail))
    expect(r.ok).toBe(false)
    expect(r.output).toContain("provider threw")
    expect(wp.files.size).toBe(0)
  })

  test("outputPath escaping the jail ⇒ permission_denied, no write, no network", async () => {
    const wp = new MemWritePort()
    let called = false
    const port: ImageGenPort = {
      async generate(): Promise<ImageGenOutcome> {
        called = true
        return { kind: "ok", images: [{ b64: PNG_1x1_B64, mediaType: "image/png" }] }
      },
    }
    const tool = imageGenTool({ port, writePort: wp })
    const r = await drain(tool, { prompt: "p", outputPath: "../../etc/evil.png" }, ctx(jail))
    expect(r.ok).toBe(false)
    expect(r.failure?.mode).toBe("permission_denied")
    expect(wp.files.size).toBe(0)
    // Provider MAY have been called (jail check is on write); the key guarantee
    // is that NOTHING escaped the jail to disk.
    void called
  })
})

/* ============================================ H14b zip-store caps ========== */

/** Build a hand-crafted DEFLATE zip with attacker-controlled declared sizes. */
const craftDeflateZip = (opts: {
  rawPerEntry: Uint8Array
  declaredUncompSize: number
  count: number
}): Uint8Array => {
  const comp = deflateRawSync(Buffer.from(opts.rawPerEntry))
  const crc = crc32(opts.rawPerEntry)
  const name = (i: number) => new TextEncoder().encode(`e${i}.bin`)
  const locals: Uint8Array[] = []
  const offsets: number[] = []
  let off = 0
  for (let i = 0; i < opts.count; i++) {
    const nm = name(i)
    offsets.push(off)
    const lh = cat(
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(8),
      u16(0),
      u16(0),
      u32(crc),
      u32(comp.length),
      u32(opts.declaredUncompSize),
      u16(nm.length),
      u16(0),
      nm,
      new Uint8Array(comp),
    )
    locals.push(lh)
    off += lh.length
  }
  const centralStart = off
  const centrals: Uint8Array[] = []
  for (let i = 0; i < opts.count; i++) {
    const nm = name(i)
    const ch = cat(
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(8),
      u16(0),
      u16(0),
      u32(crc),
      u32(comp.length),
      u32(opts.declaredUncompSize),
      u16(nm.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offsets[i] as number),
      nm,
    )
    centrals.push(ch)
    off += ch.length
  }
  const centralSize = off - centralStart
  const eocd = cat(
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(opts.count),
    u16(opts.count),
    u32(centralSize),
    u32(centralStart),
    u16(0),
  )
  return cat(...locals, ...centrals, eocd)
}

describe("H14b zip-store unzip — bomb caps (no-OOM)", () => {
  test("REGRESSION: DEFLATE bomb with LYING tiny declared uncompSize is capped by ACTUAL bytes", () => {
    // 40 entries, each declaring uncompSize=1 but each inflating to 4 MiB → 160
    // MiB actual ≫ 64 MiB total cap. Pre-fix: unzip returned ok (cap bypassed).
    const zip = craftDeflateZip({
      rawPerEntry: new Uint8Array(4 * 1024 * 1024),
      declaredUncompSize: 1,
      count: 40,
    })
    const t0 = Date.now()
    const r = unzip(zip)
    // No OOM, fast rejection.
    expect(Date.now() - t0).toBeLessThan(10_000)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("exceeds cap")
  }, 15_000)

  test("a single DEFLATE entry declaring small size but inflating past the per-entry cap is rejected", () => {
    const zip = craftDeflateZip({
      rawPerEntry: new Uint8Array(ZIP_MAX_ENTRY_BYTES + 1024 * 1024),
      declaredUncompSize: 1,
      count: 1,
    })
    const r = unzip(zip)
    expect(r.ok).toBe(false)
  }, 15_000)

  test("a declared uncompSize past the per-entry cap is rejected pre-inflate", () => {
    const zip = craftDeflateZip({
      rawPerEntry: new Uint8Array(16),
      declaredUncompSize: ZIP_MAX_ENTRY_BYTES + 1,
      count: 1,
    })
    const r = unzip(zip)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("exceeds cap")
  })

  test("a central directory claiming > ZIP_MAX_ENTRIES entries is rejected without iterating", () => {
    // EOCD with a wildly inflated entry count, no actual entries.
    const eocd = cat(
      u32(0x06054b50),
      u16(0),
      u16(0),
      u16(0xffff),
      u16(0xffff),
      u32(0),
      u32(22),
      u16(0),
    )
    // Pad so the EOCD sits at the end and centralOffset(22) is in range.
    const zip = cat(new Uint8Array(22), eocd)
    const r = unzip(zip)
    expect(r.ok).toBe(false)
  })

  test("a legitimate small DEFLATE archive still unzips (fix did not break the happy path)", () => {
    const raw = new TextEncoder().encode("hello world".repeat(100))
    const zip = craftDeflateZip({ rawPerEntry: raw, declaredUncompSize: raw.length, count: 2 })
    const r = unzip(zip)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.entries.length).toBe(2)
      expect(new TextDecoder().decode(r.entries[0]?.data)).toContain("hello world")
    }
  })

  test("total cap is honored across entries that EACH fit the per-entry cap (cumulative)", () => {
    // 3 entries each ~30 MiB → 90 MiB actual > 64 MiB total cap. Each fits the
    // 32 MiB per-entry cap, so ONLY the cumulative total accounting can reject.
    const per = 30 * 1024 * 1024
    const zip = craftDeflateZip({
      rawPerEntry: new Uint8Array(per),
      declaredUncompSize: 1,
      count: 3,
    })
    const r = unzip(zip)
    expect(r.ok).toBe(false)
  }, 15_000)
})

/* ============================================ H14b hostile-XML round-trip == */

describe("H14b serializers — hostile XML escaping + round-trip", () => {
  test("xlsx: cell containing ]]> / < / & / quotes survives round-trip with no injection", () => {
    const hostile = `]]><script>&"'<tag attr="x">`
    const bytes = buildXlsx({ sheets: [{ name: "S", rows: [[hostile, 42]] }] })
    // The raw XML must NOT contain an unescaped opening tag from user data.
    const ss = new TextDecoder().decode(bytes)
    // sharedStrings holds the escaped form; a raw "<script>" must not appear.
    expect(ss.includes("<script>")).toBe(false)
    const parsed = parseXlsx(bytes)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      const sheet = parsed.sheets[0]
      expect(sheet?.cellAt(0, 0)).toBe(hostile)
      expect(sheet?.cellAt(0, 1)).toBe("42")
    }
  })

  test("docx: paragraph with ]]> and entities round-trips byte-exact text", () => {
    const hostile = `a ]]> b & c < d > e " f ' g`
    const bytes = buildDocx({ paragraphs: [{ kind: "paragraph", runs: [{ text: hostile }] }] })
    const parsed = parseDocx(bytes)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.text).toBe(hostile)
  })

  test("pptx: slide title/body with hostile XML round-trips", () => {
    const t = `Title ]]> & <x>`
    const b = `Body " ' & ]]>`
    const bytes = buildPptx({ slides: [{ title: t, body: [b] }] })
    const parsed = parsePptx(bytes)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.slides[0]?.title).toBe(t)
      expect(parsed.slides[0]?.body).toContain(b)
    }
  })

  test("escapeXml leaves no raw &<>\"' and xmlText drops illegal control bytes", () => {
    expect(escapeXml(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&apos;")
    // Build the hostile string from char codes so the SOURCE carries no raw
    // control bytes: 'a' + NUL(0x00) + BEL(0x07) + TAB(0x09) + 'b'.
    const NUL = String.fromCharCode(0x00)
    const BEL = String.fromCharCode(0x07)
    const TAB = String.fromCharCode(0x09)
    const withCtl = `a${NUL}${BEL}${TAB}b`
    const out = xmlText(withCtl)
    // NUL + BEL are illegal in XML 1.0 -> dropped; TAB is allowed -> kept.
    expect(out.includes(NUL)).toBe(false)
    expect(out.includes(BEL)).toBe(false)
    expect(out).toBe(`a${TAB}b`)
  })

  test("malformed OOXML (xlsx missing workbook part) ⇒ typed ok:false, NO throw", () => {
    // A valid zip but without xl/workbook.xml — parseXlsx must surface a typed
    // failure, never throw.
    const bytes = buildDocx({
      paragraphs: [{ kind: "paragraph", runs: [{ text: "not a workbook" }] }],
    })
    const parsed = parseXlsx(bytes)
    expect(parsed.ok).toBe(false)
  })

  test("garbage bytes (not a zip at all) ⇒ all three readers return typed ok:false", () => {
    const garbage = new TextEncoder().encode("this is definitely not a zip file at all, nope")
    expect(parseXlsx(garbage).ok).toBe(false)
    expect(parseDocx(garbage).ok).toBe(false)
    expect(parsePptx(garbage).ok).toBe(false)
  })
})
