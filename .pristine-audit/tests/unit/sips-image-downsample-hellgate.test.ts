/**
 * Hellgate e2e — macOS `sips`-backed image downsample port (GAP 1, ADR-0507).
 *
 * Proves the REAL codec wiring: a genuine (programmatically-generated) image is
 * handed to the port, sips decodes + resizes it, and the result is a valid,
 * SMALLER image. Generated as an uncompressed 24-bit BMP (trivial to hand-encode)
 * which sips reads by content; the port writes the output as PNG (the temp file
 * extension follows the requested mediaType).
 *
 * DARWIN-GATED: `sips` is macOS only; the suite no-ops elsewhere (the port is
 * never wired off-darwin, so there is nothing to prove there).
 */
import { describe, expect, test } from "bun:test"
import { sipsImageDownsamplePort } from "@/host/runtime/sips-image-downsample"

const isDarwin = process.platform === "darwin"

/** Hand-encode a solid-color WxH 24-bit BMP (uncompressed, bottom-up). sips reads
 *  it by content regardless of the temp file's extension. */
const makeBmp = (w: number, h: number): Uint8Array => {
  const rowSize = Math.ceil((w * 3) / 4) * 4
  const dataSize = rowSize * h
  const fileSize = 54 + dataSize
  const buf = new Uint8Array(fileSize)
  const dv = new DataView(buf.buffer)
  buf[0] = 0x42 // 'B'
  buf[1] = 0x4d // 'M'
  dv.setUint32(2, fileSize, true)
  dv.setUint32(10, 54, true) // pixel data offset
  dv.setUint32(14, 40, true) // DIB header size
  dv.setInt32(18, w, true)
  dv.setInt32(22, h, true)
  dv.setUint16(26, 1, true) // planes
  dv.setUint16(28, 24, true) // bpp
  dv.setUint32(34, dataSize, true)
  // pixels: a non-uniform pattern so the resampler has real work (BGR).
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = 54 + y * rowSize + x * 3
      buf[o] = (x * 4) & 0xff // B
      buf[o + 1] = (y * 4) & 0xff // G
      buf[o + 2] = ((x + y) * 2) & 0xff // R
    }
  }
  return buf
}

/** Parse a PNG's IHDR width/height (big-endian at byte offsets 16/20). */
const pngDims = (b: Uint8Array): { w: number; h: number } => {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  return { w: dv.getUint32(16), h: dv.getUint32(20) }
}
const isPng = (b: Uint8Array): boolean =>
  b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47

describe.if(isDarwin)("sips image downsample — real resize", () => {
  test("a 64x64 image ⇒ longest edge capped at 16, valid PNG out", async () => {
    const port = sipsImageDownsamplePort()
    const out = await port.downsample(makeBmp(64, 64), "image/png", 5_000_000, 16)
    expect(out.kind).toBe("ok")
    if (out.kind !== "ok") return
    expect(isPng(out.bytes)).toBe(true)
    const { w, h } = pngDims(out.bytes)
    expect(Math.max(w, h)).toBeLessThanOrEqual(16)
    expect(w).toBeGreaterThan(0)
  })

  test("aspect ratio preserved (128x64 ⇒ 16x8)", async () => {
    const out = await sipsImageDownsamplePort().downsample(
      makeBmp(128, 64),
      "image/png",
      5_000_000,
      16,
    )
    expect(out.kind).toBe("ok")
    if (out.kind !== "ok") return
    const { w, h } = pngDims(out.bytes)
    expect(w).toBe(16)
    expect(h).toBe(8)
  })

  test("garbage bytes ⇒ ok:false unable (NO-THROW)", async () => {
    const out = await sipsImageDownsamplePort().downsample(
      new Uint8Array([1, 2, 3, 4, 5]),
      "image/png",
      5_000_000,
      16,
    )
    expect(out.kind).toBe("unable")
  })

  test("a pre-aborted signal ⇒ unable, never spawns", async () => {
    const ac = new AbortController()
    ac.abort()
    const out = await sipsImageDownsamplePort().downsample(
      makeBmp(64, 64),
      "image/png",
      5_000_000,
      16,
      ac.signal,
    )
    expect(out.kind).toBe("unable")
  })
})

describe.if(!isDarwin)("sips image downsample — non-darwin", () => {
  // `sips` is macOS-only; off-darwin the port is never wired so there is
  // nothing real to assert. Register an honest skip rather than a self-true
  // assertion (`expect(true).toBe(true)`) that exercises zero production code.
  test.skip("sips is macOS only", () => {})
})
