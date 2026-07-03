import { describe, expect, it, vi } from "vitest"
import {
  isHotkeyImagePayload,
  MAX_INLINE_IMAGE_BYTES,
  normalizeFile,
  normalizeHotkeyPng,
  type PendingImageAttachment,
  toImageBlocks,
} from "./image-attachment"
import type { ImageDownscaleDeps } from "./image-downscale"

/** Deps that report a large source and re-encode to a shrunk WEBP payload. */
const shrinkingDeps = (): ImageDownscaleDeps => ({
  decode: vi.fn(async () => ({ width: 4000, height: 2000 })),
  encodeScaled: vi.fn(async () => ({
    data: "SHRUNK",
    mediaType: "image/webp",
    byteSize: 100_000,
  })),
})

/** Deps whose decode throws — the paste must survive with original bytes. */
const failingDeps = (): ImageDownscaleDeps => ({
  decode: vi.fn(async () => {
    throw new Error("decode failed")
  }),
  encodeScaled: vi.fn(async () => {
    throw new Error("should not reach")
  }),
})

const makePngFile = (size = 1024, name = "shot.png"): File => {
  const bytes = new Uint8Array(size)
  // PNG magic so any future content-sniffer would be happy.
  bytes.set([0x89, 0x50, 0x4e, 0x47], 0)
  return new File([bytes], name, { type: "image/png" })
}

describe("normalizeFile", () => {
  it("accepts a small PNG", async () => {
    const result = await normalizeFile(makePngFile(2048, "icon.png"), "picker")
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.attachment.mediaType).toBe("image/png")
    expect(result.attachment.byteSize).toBe(2048)
    expect(result.attachment.title).toBe("icon.png")
  })

  it("rejects unsupported MIME type", async () => {
    const file = new File([new Uint8Array(8)], "shot.heic", {
      type: "image/heic",
    })
    const result = await normalizeFile(file, "picker")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain("unsupported image type")
    expect(result.error).toContain("image/heic")
  })

  it("rejects oversized image", async () => {
    const file = makePngFile(MAX_INLINE_IMAGE_BYTES + 1, "huge.png")
    const result = await normalizeFile(file, "picker")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain("image is too large")
  })

  it("paste source produces 'Pasted image' fallback title", async () => {
    const file = new File([new Uint8Array(8)], "", { type: "image/png" })
    const result = await normalizeFile(file, "paste")
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.attachment.title).toBe("Pasted image")
    expect(result.attachment.subtitle).toContain("pasted from clipboard")
  })
})

describe("normalizeHotkeyPng", () => {
  it("accepts a small capture and labels it from monitor name", async () => {
    const result = await normalizeHotkeyPng({
      kind: "quanta:hotkey-image-capture",
      pngBase64: "AAAA",
      monitorName: "LG 27UK",
      capturedAtMs: 1_700_000_000_000,
      byteSize: 512_000,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.attachment.mediaType).toBe("image/png")
    expect(result.attachment.title).toBe("LG 27UK")
    expect(result.attachment.previewAlt).toBe("Screenshot from LG 27UK")
  })

  it("falls back to 'Active monitor' when monitorName is empty", async () => {
    const result = await normalizeHotkeyPng({
      kind: "quanta:hotkey-image-capture",
      pngBase64: "AAAA",
      monitorName: "",
      capturedAtMs: 0,
      byteSize: 128,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.attachment.title).toBe("Active monitor")
  })

  // Regression — the previous shape had this path bypass the cap entirely.
  it("rejects a capture above MAX_INLINE_IMAGE_BYTES", async () => {
    const result = await normalizeHotkeyPng({
      kind: "quanta:hotkey-image-capture",
      pngBase64: "AAAA",
      monitorName: "5K Display",
      capturedAtMs: 0,
      byteSize: MAX_INLINE_IMAGE_BYTES + 1,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain("screen capture is too large")
  })
})

describe("isHotkeyImagePayload", () => {
  it("accepts a well-formed payload", () => {
    expect(
      isHotkeyImagePayload({
        kind: "quanta:hotkey-image-capture",
        pngBase64: "AAAA",
        monitorName: "m",
        capturedAtMs: 1,
        byteSize: 2,
      }),
    ).toBe(true)
  })

  it("rejects wrong kind", () => {
    expect(
      isHotkeyImagePayload({
        kind: "quanta:hotkey-send",
        pngBase64: "AAAA",
        monitorName: "m",
        capturedAtMs: 1,
        byteSize: 2,
      }),
    ).toBe(false)
  })

  it("rejects missing fields", () => {
    expect(isHotkeyImagePayload({ kind: "quanta:hotkey-image-capture" })).toBe(false)
  })
})

describe("downscale wiring", () => {
  const bigFile = (size = 6_000_000, name = "screenshot.png"): File => {
    const bytes = new Uint8Array(Math.min(size, 4)) // small buffer, size lied via property
    bytes.set([0x89, 0x50, 0x4e, 0x47], 0)
    const f = new File([bytes], name, { type: "image/png" })
    Object.defineProperty(f, "size", { value: size })
    return f
  }

  it("normalizeFile replaces payload with the shrunk downscaled result", async () => {
    const deps = shrinkingDeps()
    const result = await normalizeFile(bigFile(), "paste", deps)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.attachment.data).toBe("SHRUNK")
    expect(result.attachment.mediaType).toBe("image/webp")
    expect(result.attachment.byteSize).toBe(100_000)
    // subtitle KB reflects the SHRUNK size, not the original 6MB
    expect(result.attachment.subtitle).toContain("98 KB")
    expect(deps.encodeScaled).toHaveBeenCalledOnce()
  })

  it("normalizeFile keeps ORIGINAL bytes when decode fails (paste never crashes)", async () => {
    const deps = failingDeps()
    const result = await normalizeFile(bigFile(5_000_000), "paste", deps)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.attachment.byteSize).toBe(5_000_000)
    expect(result.attachment.mediaType).toBe("image/png")
    expect(deps.encodeScaled).not.toHaveBeenCalled()
  })

  it("normalizeFile leaves a genuinely small image untouched (no re-encode)", async () => {
    const deps: ImageDownscaleDeps = {
      decode: vi.fn(async () => ({ width: 640, height: 480 })),
      encodeScaled: vi.fn(async () => {
        throw new Error("should not encode small image")
      }),
    }
    const result = await normalizeFile(makePngFile(50_000, "icon.png"), "picker", deps)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.attachment.byteSize).toBe(50_000)
    expect(deps.encodeScaled).not.toHaveBeenCalled()
  })

  it("normalizeHotkeyPng downscales a large capture via injected deps", async () => {
    const deps = shrinkingDeps()
    const result = await normalizeHotkeyPng(
      {
        kind: "quanta:hotkey-image-capture",
        pngBase64: "AAAA",
        monitorName: "5K Display",
        capturedAtMs: 0,
        byteSize: 8_000_000,
      },
      deps,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.attachment.data).toBe("SHRUNK")
    expect(result.attachment.mediaType).toBe("image/webp")
    expect(result.attachment.byteSize).toBe(100_000)
  })

  it("normalizeHotkeyPng still enforces the hard byte cap BEFORE downscaling", async () => {
    const deps = shrinkingDeps()
    const result = await normalizeHotkeyPng(
      {
        kind: "quanta:hotkey-image-capture",
        pngBase64: "AAAA",
        monitorName: "5K Display",
        capturedAtMs: 0,
        byteSize: MAX_INLINE_IMAGE_BYTES + 1,
      },
      deps,
    )
    expect(result.ok).toBe(false)
    // over the hard cap => refused, decode/encode never attempted
    expect(deps.decode).not.toHaveBeenCalled()
  })
})

describe("toImageBlocks", () => {
  const make = (data: string, mediaType = "image/png"): PendingImageAttachment => ({
    data,
    mediaType,
    byteSize: data.length,
    title: "t",
    subtitle: "s",
    previewAlt: "a",
  })

  it("returns undefined for an empty pendings array", () => {
    expect(toImageBlocks([])).toBeUndefined()
  })

  it("returns a single-element ImageBlock array for one pending", () => {
    const blocks = toImageBlocks([make("AAAA")])
    expect(blocks).toEqual([{ type: "image", mediaType: "image/png", data: "AAAA" }])
  })

  it("preserves order across multiple pendings", () => {
    const blocks = toImageBlocks([
      make("AAAA", "image/png"),
      make("BBBB", "image/jpeg"),
      make("CCCC", "image/webp"),
    ])
    expect(blocks).toEqual([
      { type: "image", mediaType: "image/png", data: "AAAA" },
      { type: "image", mediaType: "image/jpeg", data: "BBBB" },
      { type: "image", mediaType: "image/webp", data: "CCCC" },
    ])
  })
})
