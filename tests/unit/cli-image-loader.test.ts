/**
 * ADR-0083 — CLI image-loader: extension→mediaType inference, base64
 * round-trip, unsupported-type + oversize rejection.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  loadImageBlock,
  MAX_IMAGE_BYTES,
  SUPPORTED_IMAGE_TYPES,
} from "../../src/apps/cli/image-loader"

const work = mkdtempSync(join(tmpdir(), "quanta-img-loader-"))
const writeImg = (name: string, bytes: Uint8Array): string => {
  const p = join(work, name)
  writeFileSync(p, bytes)
  return p
}

describe("loadImageBlock", () => {
  test("png → image/png, base64 round-trips", () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]) // PNG magic-ish
    const block = loadImageBlock(writeImg("a.png", bytes))
    expect(block.type).toBe("image")
    expect(block.mediaType).toBe("image/png")
    expect(Buffer.from(block.data, "base64")).toEqual(Buffer.from(bytes))
  })

  test(".jpg and .jpeg both → image/jpeg", () => {
    expect(loadImageBlock(writeImg("b.jpg", new Uint8Array([1]))).mediaType).toBe("image/jpeg")
    expect(loadImageBlock(writeImg("c.jpeg", new Uint8Array([1]))).mediaType).toBe("image/jpeg")
  })

  test(".webp and .gif map correctly", () => {
    expect(loadImageBlock(writeImg("d.webp", new Uint8Array([1]))).mediaType).toBe("image/webp")
    expect(loadImageBlock(writeImg("e.gif", new Uint8Array([1]))).mediaType).toBe("image/gif")
  })

  test("extension is case-insensitive", () => {
    expect(loadImageBlock(writeImg("f.PNG", new Uint8Array([1]))).mediaType).toBe("image/png")
  })

  test("unsupported extension throws with a helpful message", () => {
    expect(() => loadImageBlock(writeImg("g.bmp", new Uint8Array([1])))).toThrow(
      /unsupported image type/,
    )
    expect(() => loadImageBlock(writeImg("noext", new Uint8Array([1])))).toThrow(/no extension/)
  })

  test("oversize file throws", () => {
    // Stub a file just over the cap without actually allocating 20MB: write a
    // sparse-ish buffer. We allocate cap+1 bytes (acceptable for a unit test).
    const big = new Uint8Array(MAX_IMAGE_BYTES + 1)
    expect(() => loadImageBlock(writeImg("big.png", big))).toThrow(/max/)
  })

  test("SUPPORTED_IMAGE_TYPES is the four-type closed set", () => {
    expect(Object.values(SUPPORTED_IMAGE_TYPES).sort()).toEqual([
      "image/gif",
      "image/jpeg",
      "image/jpeg",
      "image/png",
      "image/webp",
    ])
  })
})
