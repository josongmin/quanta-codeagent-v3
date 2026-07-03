import { describe, expect, it, vi } from "vitest"
import {
  computeTargetDimensions,
  DOWNSCALE_ENCODE_QUALITY,
  downscaleBase64Image,
  type ImageDecodeResult,
  type ImageDownscaleDeps,
  MAX_ENCODED_IMAGE_BYTES,
  MAX_IMAGE_LONG_EDGE,
  shouldDownscale,
} from "./image-downscale"

/** Read the arguments of the first recorded call to a mocked fn. */
const firstCallArgs = (fn: unknown): unknown[] => {
  const calls = (fn as ReturnType<typeof vi.fn>).mock.calls
  expect(calls.length).toBeGreaterThan(0)
  const first = calls[0]
  if (first === undefined) throw new Error("expected at least one call")
  return first
}

// ---------------------------------------------------------------------------
// Pure decision: shouldDownscale
// ---------------------------------------------------------------------------
describe("shouldDownscale", () => {
  it("triggers when the long edge exceeds the cap (width-dominant)", () => {
    expect(
      shouldDownscale({
        width: MAX_IMAGE_LONG_EDGE + 1,
        height: 100,
        mediaType: "image/png",
        encodedBytes: 1000,
      }),
    ).toBe(true)
  })

  it("triggers when the long edge exceeds the cap (height-dominant)", () => {
    expect(
      shouldDownscale({
        width: 100,
        height: MAX_IMAGE_LONG_EDGE + 1,
        mediaType: "image/png",
        encodedBytes: 1000,
      }),
    ).toBe(true)
  })

  it("triggers when encoded bytes exceed the byte cap even if dimensions are small", () => {
    expect(
      shouldDownscale({
        width: 800,
        height: 600,
        mediaType: "image/jpeg",
        encodedBytes: MAX_ENCODED_IMAGE_BYTES + 1,
      }),
    ).toBe(true)
  })

  it("never triggers for GIF (canvas re-encode would de-animate it)", () => {
    expect(
      shouldDownscale({
        width: MAX_IMAGE_LONG_EDGE + 5000,
        height: MAX_IMAGE_LONG_EDGE + 5000,
        mediaType: "image/gif",
        encodedBytes: MAX_ENCODED_IMAGE_BYTES + 1_000_000,
      }),
    ).toBe(false)
  })

  it("does NOT trigger for a small image within both caps (passthrough)", () => {
    expect(
      shouldDownscale({
        width: 800,
        height: 600,
        mediaType: "image/png",
        encodedBytes: 50_000,
      }),
    ).toBe(false)
  })

  it("does NOT trigger exactly at the long-edge cap (boundary is inclusive-ok)", () => {
    expect(
      shouldDownscale({
        width: MAX_IMAGE_LONG_EDGE,
        height: MAX_IMAGE_LONG_EDGE,
        mediaType: "image/png",
        encodedBytes: 100,
      }),
    ).toBe(false)
  })

  it("does NOT trigger exactly at the byte cap (boundary is inclusive-ok)", () => {
    expect(
      shouldDownscale({
        width: 10,
        height: 10,
        mediaType: "image/png",
        encodedBytes: MAX_ENCODED_IMAGE_BYTES,
      }),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Pure math: computeTargetDimensions
// ---------------------------------------------------------------------------
describe("computeTargetDimensions", () => {
  it("scales a landscape image so the long edge equals the cap", () => {
    const t = computeTargetDimensions(4000, 2000)
    expect(t.width).toBe(MAX_IMAGE_LONG_EDGE)
    expect(t.height).toBe(Math.round((MAX_IMAGE_LONG_EDGE * 2000) / 4000))
  })

  it("scales a portrait image so the long edge equals the cap", () => {
    const t = computeTargetDimensions(2000, 4000)
    expect(t.height).toBe(MAX_IMAGE_LONG_EDGE)
    expect(t.width).toBe(Math.round((MAX_IMAGE_LONG_EDGE * 2000) / 4000))
  })

  it("preserves aspect ratio within a rounding tolerance", () => {
    const srcW = 5120
    const srcH = 2880 // 16:9
    const t = computeTargetDimensions(srcW, srcH)
    const srcRatio = srcW / srcH
    const dstRatio = t.width / t.height
    expect(Math.abs(srcRatio - dstRatio)).toBeLessThan(0.02)
  })

  it("never upscales — an already-small image is returned unchanged", () => {
    const t = computeTargetDimensions(800, 600)
    expect(t).toEqual({ width: 800, height: 600 })
  })

  it("clamps a square image to the cap on both edges", () => {
    const t = computeTargetDimensions(4000, 4000)
    expect(t).toEqual({ width: MAX_IMAGE_LONG_EDGE, height: MAX_IMAGE_LONG_EDGE })
  })

  it("floors target dimensions to at least 1px (degenerate ultra-wide)", () => {
    // 10000 x 1 -> width caps to MAX_IMAGE_LONG_EDGE, height would round to 0.
    const t = computeTargetDimensions(10000, 1)
    expect(t.width).toBe(MAX_IMAGE_LONG_EDGE)
    expect(t.height).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// Orchestrator: downscaleBase64Image (decode+encode injected)
// ---------------------------------------------------------------------------
const B64_1PX = "AAAA"

const makeDeps = (overrides: Partial<ImageDownscaleDeps> = {}): ImageDownscaleDeps => ({
  decode: vi.fn(async (): Promise<ImageDecodeResult> => ({ width: 4000, height: 2000 })),
  encodeScaled: vi.fn(
    async (): Promise<{ data: string; mediaType: string; byteSize: number }> => ({
      data: "SCALED",
      mediaType: "image/webp",
      byteSize: 12_345,
    }),
  ),
  ...overrides,
})

describe("downscaleBase64Image", () => {
  it("passes through an image within BOTH pixel and byte caps (no re-encode)", async () => {
    // Small bytes still get decoded (a solid-color 5K screenshot is tiny in
    // bytes yet huge in pixels — decoding is what protects the DOM decode cost).
    // Here the pixels are also in-cap, so it passes through unchanged.
    const deps = makeDeps({
      decode: vi.fn(async () => ({ width: 640, height: 480 })),
    })
    const out = await downscaleBase64Image(
      { data: B64_1PX, mediaType: "image/png", byteSize: 40_000 },
      deps,
    )
    expect(out).toEqual({
      data: B64_1PX,
      mediaType: "image/png",
      byteSize: 40_000,
    })
    // in-cap pixels => never re-encode
    expect(deps.encodeScaled).not.toHaveBeenCalled()
  })

  it("downscales a small-BYTE but large-PIXEL image (DOM decode-cost guard)", async () => {
    // e.g. a solid-color 5000x2500 screenshot: ~tiny PNG bytes, but decodes to
    // 50M pixels = ~200MB in the DOM. Must still be scaled to the pixel cap.
    const deps = makeDeps({
      decode: vi.fn(async () => ({ width: 5000, height: 2500 })),
      encodeScaled: vi.fn(async () => ({
        data: "SCALED",
        mediaType: "image/png",
        byteSize: 20_000,
      })),
    })
    const out = await downscaleBase64Image(
      { data: B64_1PX, mediaType: "image/png", byteSize: 30_000 },
      deps,
    )
    expect(deps.encodeScaled).toHaveBeenCalledOnce()
    const [, target] = firstCallArgs(deps.encodeScaled)
    expect(target).toEqual({ width: MAX_IMAGE_LONG_EDGE, height: 800 })
    expect(out.data).toBe("SCALED")
  })

  it("downscales a large image and returns the re-encoded payload", async () => {
    const deps = makeDeps()
    const out = await downscaleBase64Image(
      { data: "BIGDATA", mediaType: "image/png", byteSize: 5_000_000 },
      deps,
    )
    expect(out.data).toBe("SCALED")
    expect(out.mediaType).toBe("image/webp")
    expect(out.byteSize).toBe(12_345)
    expect(deps.encodeScaled).toHaveBeenCalledOnce()
    // target dims must be the cap-clamped values, not the source
    const [, target] = firstCallArgs(deps.encodeScaled)
    expect(target).toEqual({ width: MAX_IMAGE_LONG_EDGE, height: 800 })
  })

  it("passes the configured encode quality through to the encoder", async () => {
    const deps = makeDeps()
    await downscaleBase64Image(
      { data: "BIGDATA", mediaType: "image/png", byteSize: 5_000_000 },
      deps,
    )
    const [, , opts] = firstCallArgs(deps.encodeScaled)
    expect((opts as { quality: number }).quality).toBe(DOWNSCALE_ENCODE_QUALITY)
  })

  it("falls back to the ORIGINAL payload when decode throws (never crashes)", async () => {
    const deps = makeDeps({
      decode: vi.fn(async () => {
        throw new Error("decode boom")
      }),
    })
    const original = {
      data: "BIGDATA",
      mediaType: "image/png",
      byteSize: 5_000_000,
    }
    const out = await downscaleBase64Image(original, deps)
    expect(out).toEqual(original)
    expect(deps.encodeScaled).not.toHaveBeenCalled()
  })

  it("falls back to the ORIGINAL payload when encode throws", async () => {
    const deps = makeDeps({
      encodeScaled: vi.fn(async () => {
        throw new Error("encode boom")
      }),
    })
    const original = {
      data: "BIGDATA",
      mediaType: "image/png",
      byteSize: 5_000_000,
    }
    const out = await downscaleBase64Image(original, deps)
    expect(out).toEqual(original)
  })

  it("keeps the re-encoded result only when it is actually smaller; else keeps original", async () => {
    // Encoder returns something LARGER than the original — must not regress.
    const deps = makeDeps({
      encodeScaled: vi.fn(async () => ({
        data: "SCALED_BUT_BIGGER",
        mediaType: "image/webp",
        byteSize: 9_000_000,
      })),
    })
    const original = {
      data: "BIGDATA",
      mediaType: "image/png",
      byteSize: 5_000_000,
    }
    const out = await downscaleBase64Image(original, deps)
    expect(out).toEqual(original)
  })

  it("preserves PNG (lossless) for images that need scaling but request png passthrough", async () => {
    // When encoder chooses to keep PNG for transparency, mediaType is honored.
    const deps = makeDeps({
      encodeScaled: vi.fn(async () => ({
        data: "SCALED_PNG",
        mediaType: "image/png",
        byteSize: 100_000,
      })),
    })
    const out = await downscaleBase64Image(
      { data: "BIGDATA", mediaType: "image/png", byteSize: 5_000_000 },
      deps,
    )
    expect(out.mediaType).toBe("image/png")
    expect(out.data).toBe("SCALED_PNG")
  })

  it("passes a large GIF through unchanged (animation preserved)", async () => {
    const deps = makeDeps({
      decode: vi.fn(async () => ({ width: 4000, height: 4000 })),
    })
    const original = {
      data: "GIFDATA",
      mediaType: "image/gif",
      byteSize: MAX_ENCODED_IMAGE_BYTES + 1,
    }
    const out = await downscaleBase64Image(original, deps)
    expect(out).toEqual(original)
    expect(deps.encodeScaled).not.toHaveBeenCalled()
  })

  it("triggers on byte-cap breach even when dimensions are under the edge cap", async () => {
    const deps = makeDeps({
      decode: vi.fn(async () => ({ width: 1000, height: 1000 })),
      encodeScaled: vi.fn(async () => ({
        data: "SMALLER",
        mediaType: "image/webp",
        byteSize: 500_000,
      })),
    })
    const out = await downscaleBase64Image(
      { data: "BIG", mediaType: "image/jpeg", byteSize: MAX_ENCODED_IMAGE_BYTES + 1 },
      deps,
    )
    expect(deps.encodeScaled).toHaveBeenCalledOnce()
    expect(out.data).toBe("SMALLER")
    // dims under the edge cap => target equals source dims (no upscale)
    const [, target] = firstCallArgs(deps.encodeScaled)
    expect(target).toEqual({ width: 1000, height: 1000 })
  })
})
