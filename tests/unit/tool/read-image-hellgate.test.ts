/**
 * Hellgate — `read_image` tool + composer + sniffer (ADR-0126).
 *
 * Seal:
 *   A. Tool metadata (name / read-only=true / concurrency-safe=true / no hitlTier)
 *   B. Input schema (zod min(1) on `path`)
 *   C. Path safety (abs vs relative, .. traversal)
 *   D. File semantics (missing / symlink leaf / size cap / bad magic)
 *   E. Happy path for all 4 supported media types (PNG/JPEG/WebP/GIF)
 *   F. composeToolResultContent (absent / empty / present / empty-text)
 *   G. sniffMediaType (all 4 magic byte signatures + null on random bytes)
 *
 * No mocks for FS — uses a real tmpdir with real bytes. The 4 image fixtures
 * are crafted to satisfy magic-byte sniffing only (decoding is NOT exercised
 * because the tool never decodes — it base64-encodes the raw bytes).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  composeToolResultContent,
  MAX_IMAGE_BYTES,
  readImageTool,
  SUPPORTED_MEDIA_TYPES,
  sniffMediaType,
} from "@/tool/image"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

/* ------------------------------------------------------------------ */
/* harness                                                             */
/* ------------------------------------------------------------------ */

let workDir = ""

const ctx = (signal?: AbortSignal, cwdOverride?: string): ToolContext => ({
  cwd: cwdOverride ?? workDir,
  signal: signal ?? new AbortController().signal,
})

const collect = async (input: unknown, c: ToolContext = ctx()): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of readImageTool.execute(input as never, c) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no terminal result")
  return result
}

/* ------------------------------------------------------------------ */
/* magic-byte fixture builders                                         */
/* ------------------------------------------------------------------ */

/** Minimal 1×1 PNG (67 bytes) — magic + IHDR + IDAT + IEND. The bytes are a
 *  well-known canonical-minimal PNG; we don't try to decode, only sniff. */
const PNG_1x1 = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a, // signature
  0x00,
  0x00,
  0x00,
  0x0d,
  0x49,
  0x48,
  0x44,
  0x52, // IHDR length+type
  0x00,
  0x00,
  0x00,
  0x01,
  0x00,
  0x00,
  0x00,
  0x01, // 1x1
  0x08,
  0x06,
  0x00,
  0x00,
  0x00,
  0x1f,
  0x15,
  0xc4,
  0x89, // bit depth/etc + crc
  0x00,
  0x00,
  0x00,
  0x0d,
  0x49,
  0x44,
  0x41,
  0x54, // IDAT
  0x78,
  0x9c,
  0x62,
  0x00,
  0x01,
  0x00,
  0x00,
  0x05,
  0x00,
  0x01,
  0x0d,
  0x0a,
  0x2d,
  0xb4,
  0x00,
  0x00,
  0x00,
  0x00,
  0x49,
  0x45,
  0x4e,
  0x44, // IEND
  0xae,
  0x42,
  0x60,
  0x82,
])

/** Minimal JPEG header — `FF D8 FF E0` (JFIF) + a tiny body. Magic-byte sniff
 *  only looks at the first 3 bytes; a real decoder would reject this. */
const JPEG_MIN = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
])

/** Minimal GIF — `GIF89a` + 7 bytes of LSD (logical screen descriptor) + a
 *  trailing `3B` (semicolon) terminator. Magic sniff only looks at first 6. */
const GIF_MIN = new Uint8Array([
  0x47,
  0x49,
  0x46,
  0x38,
  0x39,
  0x61, // "GIF89a"
  0x01,
  0x00,
  0x01,
  0x00,
  0x80,
  0x00,
  0x00, // LSD
  0x3b, // trailer
])

/** Minimal WebP — `RIFF` + 4-byte length + `WEBP`. Magic sniff inspects bytes
 *  0..3 and 8..11; bytes 4..7 are the size and irrelevant to sniffing. */
const WEBP_MIN = new Uint8Array([
  0x52,
  0x49,
  0x46,
  0x46, // "RIFF"
  0x1a,
  0x00,
  0x00,
  0x00, // file size (placeholder)
  0x57,
  0x45,
  0x42,
  0x50, // "WEBP"
  0x56,
  0x50,
  0x38,
  0x4c, // "VP8L" chunk header
  0x0d,
  0x00,
  0x00,
  0x00, // chunk size
  0x2f,
  0x00,
  0x00,
  0x00,
  0x00,
  0x88,
  0x88,
  0x08,
  0x07,
  0x10,
  0x10,
  0x11,
  0x11,
])

/* ------------------------------------------------------------------ */
/* lifecycle                                                           */
/* ------------------------------------------------------------------ */

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "read-image-hellgate-"))
  await writeFile(path.join(workDir, "tiny.png"), PNG_1x1)
  await writeFile(path.join(workDir, "tiny.jpg"), JPEG_MIN)
  await writeFile(path.join(workDir, "tiny.gif"), GIF_MIN)
  await writeFile(path.join(workDir, "tiny.webp"), WEBP_MIN)
  // Text file with .png extension — magic-byte sniff MUST win over extension.
  await writeFile(path.join(workDir, "spoofed.png"), "not actually a PNG")
  // Symlink pointing at the real PNG — leaf-symlink reject case.
  await symlink(path.join(workDir, "tiny.png"), path.join(workDir, "link.png"))
  // Oversized fake — > 5 MB. Bytes don't need to be a real image; the size
  // check runs BEFORE the magic-byte sniff.
  const big = new Uint8Array(MAX_IMAGE_BYTES + 1)
  big[0] = 0x89
  big[1] = 0x50
  big[2] = 0x4e
  big[3] = 0x47
  await writeFile(path.join(workDir, "big.png"), big)
})

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true })
})

/* ------------------------------------------------------------------ */
/* A. Tool metadata                                                    */
/* ------------------------------------------------------------------ */

describe("A. metadata", () => {
  test("1. name", () => {
    expect(readImageTool.name).toBe("read_image")
  })
  test("2. isReadOnly()", () => {
    expect(readImageTool.isReadOnly()).toBe(true)
  })
  test("3. isConcurrencySafe()", () => {
    expect(readImageTool.isConcurrencySafe({ path: "x.png" })).toBe(true)
  })
  test("4. no hitlTier hook (defaults to none via isReadOnly inference)", () => {
    expect(readImageTool.hitlTier).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ */
/* B. Input schema                                                     */
/* ------------------------------------------------------------------ */

describe("B. schema", () => {
  test("5. {} (no path) → ok:false", async () => {
    const r = await collect({})
    expect(r.ok).toBe(false)
    expect(r.output).toContain("invalid input")
  })
  test("6. {path:''} → ok:false (min(1))", async () => {
    const r = await collect({ path: "" })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("invalid input")
  })
  test("7. {path:'x.png'} accepted (then FS-not-found)", async () => {
    const r = await collect({ path: "nonexistent.png" })
    expect(r.ok).toBe(false)
    // Past schema parse → FS-side error message.
    expect(r.output).not.toContain("invalid input")
  })
})

/* ------------------------------------------------------------------ */
/* C. Path safety                                                      */
/* ------------------------------------------------------------------ */

describe("C. path safety", () => {
  test("8. absolute path to existing image → reads", async () => {
    const r = await collect({ path: path.join(workDir, "tiny.png") })
    expect(r.ok).toBe(true)
    expect(r.images?.[0]?.mediaType).toBe("image/png")
  })
  test("9. repo-relative path → resolved against cwd", async () => {
    const r = await collect({ path: "tiny.jpg" })
    expect(r.ok).toBe(true)
    expect(r.images?.[0]?.mediaType).toBe("image/jpeg")
  })
  test("10. relative ../.. escape → ok:false (path-outside-cwd or symlink)", async () => {
    const r = await collect({ path: "../../../etc/passwd" })
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/outside cwd|symlink|not found|lstat/i)
  })
})

/* ------------------------------------------------------------------ */
/* D. File semantics                                                   */
/* ------------------------------------------------------------------ */

describe("D. file semantics", () => {
  test("11. missing file → ok:false not_found", async () => {
    const r = await collect({ path: "does-not-exist.png" })
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/not found|ENOENT/i)
    expect(r.failure?.mode).toBe("not_found")
  })
  test("12. symlink leaf → ok:false symlink not allowed", async () => {
    const r = await collect({ path: "link.png" })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("symlink not allowed")
    expect(r.failure?.mode).toBe("permission_denied")
    expect(r.failure?.isReadonly).toBe(true)
  })
  test("13. file > 5MB → ok:false image too large", async () => {
    const r = await collect({ path: "big.png" })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("image too large")
  })
  test("14. spoofed extension (text bytes, .png name) → ok:false unsupported", async () => {
    const r = await collect({ path: "spoofed.png" })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("unsupported or unrecognized")
  })
})

/* ------------------------------------------------------------------ */
/* E. Happy path (all 4 supported types)                               */
/* ------------------------------------------------------------------ */

describe("E. happy path", () => {
  test("15. PNG → ok:true, single image block, base64-decodable", async () => {
    const r = await collect({ path: "tiny.png" })
    expect(r.ok).toBe(true)
    expect(r.images).toBeDefined()
    expect(r.images?.length).toBe(1)
    const img = r.images?.[0]
    expect(img?.type).toBe("image")
    expect(img?.mediaType).toBe("image/png")
    // base64 decodes to the original bytes.
    const decoded = Buffer.from(img?.data ?? "", "base64")
    expect(decoded.length).toBe(PNG_1x1.length)
    expect(decoded[0]).toBe(0x89)
    expect(r.output).toContain("image/png")
    expect(r.output).toContain("tiny.png")
  })
  test("16. JPEG → mediaType image/jpeg", async () => {
    const r = await collect({ path: "tiny.jpg" })
    expect(r.ok).toBe(true)
    expect(r.images?.[0]?.mediaType).toBe("image/jpeg")
  })
  test("17. WebP → mediaType image/webp", async () => {
    const r = await collect({ path: "tiny.webp" })
    expect(r.ok).toBe(true)
    expect(r.images?.[0]?.mediaType).toBe("image/webp")
  })
  test("18. GIF → mediaType image/gif", async () => {
    const r = await collect({ path: "tiny.gif" })
    expect(r.ok).toBe(true)
    expect(r.images?.[0]?.mediaType).toBe("image/gif")
  })
})

/* ------------------------------------------------------------------ */
/* F. composeToolResultContent                                         */
/* ------------------------------------------------------------------ */

describe("F. composeToolResultContent", () => {
  test("19. no images field → returns string (byte-identical)", () => {
    const out = composeToolResultContent({ ok: true, output: "hello" })
    expect(out).toBe("hello")
  })
  test("20. images: [] → returns string (treat empty as absent)", () => {
    const out = composeToolResultContent({ ok: true, output: "hello", images: [] })
    expect(out).toBe("hello")
  })
  test("21. output + 1 image → returns array [text, image]", () => {
    const img = { type: "image" as const, data: "AAAA", mediaType: "image/png" }
    const out = composeToolResultContent({ ok: true, output: "x", images: [img] })
    expect(Array.isArray(out)).toBe(true)
    if (!Array.isArray(out)) throw new Error("unreachable")
    expect(out.length).toBe(2)
    expect(out[0]).toEqual({ type: "text", text: "x" })
    expect(out[1]).toBe(img)
  })
  test("22. empty output + 1 image → array preserves empty text", () => {
    const img = { type: "image" as const, data: "AAAA", mediaType: "image/png" }
    const out = composeToolResultContent({ ok: true, output: "", images: [img] })
    expect(Array.isArray(out)).toBe(true)
    if (!Array.isArray(out)) throw new Error("unreachable")
    expect(out[0]).toEqual({ type: "text", text: "" })
  })
})

/* ------------------------------------------------------------------ */
/* G. sniffMediaType                                                   */
/* ------------------------------------------------------------------ */

describe("G. sniffMediaType", () => {
  test("23. PNG magic → image/png", () => {
    expect(sniffMediaType(PNG_1x1)).toBe("image/png")
  })
  test("24. JPEG magic → image/jpeg", () => {
    expect(sniffMediaType(JPEG_MIN)).toBe("image/jpeg")
  })
  test("25. WebP magic → image/webp", () => {
    expect(sniffMediaType(WEBP_MIN)).toBe("image/webp")
  })
  test("26. GIF magic → image/gif", () => {
    expect(sniffMediaType(GIF_MIN)).toBe("image/gif")
  })
  test("27. random bytes → null", () => {
    expect(sniffMediaType(new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04]))).toBe(null)
    expect(sniffMediaType(new Uint8Array(0))).toBe(null)
    expect(sniffMediaType(new TextEncoder().encode("hello world"))).toBe(null)
  })
  test("(meta) SUPPORTED_MEDIA_TYPES covers all 4", () => {
    expect(SUPPORTED_MEDIA_TYPES.length).toBe(4)
  })
})
