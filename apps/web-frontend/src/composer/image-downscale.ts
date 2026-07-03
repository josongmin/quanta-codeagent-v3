/**
 * Client-side image downscaling for composer attachments.
 *
 * WHY: pasted/attached screenshots were stored and sent as FULL-resolution
 * base64. A 4-5K screenshot inflates to multiple MB that is (a) held in React
 * state, (b) shipped over the wire, and (c) decoded at full resolution in the
 * DOM `<img src>`. `MessageBubble` only caps *display* size, not the decoded
 * or stored bytes. This module shrinks large images before they enter the
 * pending queue while leaving small images byte-identical (no needless quality
 * loss).
 *
 * DEFAULTS (measure-first, provider-aligned — not arbitrary):
 *   - MAX_IMAGE_LONG_EDGE = 1600px. Anthropic's vision guidance recommends the
 *     long edge stay at/under ~1568px (≈1.15 MP); larger images are downscaled
 *     server-side anyway, so sending more is pure waste. OpenAI's high-detail
 *     tiling bounds the effective resolution similarly (2048² bound, 768px short
 *     side). 1600 sits just above Anthropic's knee — a safe, model-friendly cap.
 *   - MAX_ENCODED_IMAGE_BYTES = 1.5MB base64. A byte backstop for images that
 *     are within the edge cap but still heavy (e.g. dense JPEG photos). Well
 *     under the 20MB inline hard cap, which stays as a final refusal backstop.
 *   - DOWNSCALE_ENCODE_QUALITY = 0.85. Standard "visually lossless-ish" JPEG/
 *     WEBP quality; the browser encoder decides format (WEBP/JPEG for opaque,
 *     PNG kept for images needing lossless/transparency).
 *
 * TESTABILITY: the decision (`shouldDownscale`) and the target-dimension math
 * (`computeTargetDimensions`) are pure and unit-tested in the node vitest env.
 * The actual decode+canvas encode is injected via `ImageDownscaleDeps` so tests
 * mock it (node has no canvas / createImageBitmap). `createBrowserDownscaleDeps`
 * builds the real deps and is a no-op-safe factory when the DOM APIs are absent.
 */

/** Longest-edge cap in pixels. See module header for provenance. */
export const MAX_IMAGE_LONG_EDGE = 1600

/** Byte backstop (bytes of base64) above which we attempt a re-encode. */
export const MAX_ENCODED_IMAGE_BYTES = 1_500_000

/** Lossy re-encode quality passed to the browser encoder. */
export const DOWNSCALE_ENCODE_QUALITY = 0.85

/** Raw base64 payload + metadata — mirrors the composer's attachment shape. */
export interface Base64ImagePayload {
  readonly data: string
  readonly mediaType: string
  readonly byteSize: number
}

/** Decoded intrinsic dimensions of an image. */
export interface ImageDecodeResult {
  readonly width: number
  readonly height: number
}

export interface TargetDimensions {
  readonly width: number
  readonly height: number
}

export interface EncodeOptions {
  readonly quality: number
  /** The source media type — lets the encoder prefer lossless for PNG/alpha. */
  readonly sourceMediaType: string
}

/**
 * Injectable image-decode + scaled-encode dependency. In the browser this is
 * backed by `createImageBitmap` + `<canvas>`; in tests it is mocked.
 */
export interface ImageDownscaleDeps {
  /** Decode base64 (no data-url prefix) to intrinsic dimensions. */
  readonly decode: (data: string, mediaType: string) => Promise<ImageDecodeResult>
  /** Draw the decoded image at `target` size and re-encode to base64. */
  readonly encodeScaled: (
    data: string,
    target: TargetDimensions,
    opts: EncodeOptions,
  ) => Promise<Base64ImagePayload>
}

interface DownscaleDecisionInput {
  readonly width: number
  readonly height: number
  readonly mediaType: string
  readonly encodedBytes: number
}

/**
 * Decide whether an image is worth downscaling. Pure. Triggers when either the
 * long edge exceeds the pixel cap OR the encoded size exceeds the byte cap.
 * Boundary values (== cap) are treated as acceptable (no downscale).
 *
 * GIFs are exempt: a `<canvas>` re-encode captures only the first frame, which
 * would silently de-animate the image. We leave GIFs verbatim and rely on the
 * 20MB inline hard cap as the sole backstop for them.
 */
export const shouldDownscale = (info: DownscaleDecisionInput): boolean => {
  if (info.mediaType === "image/gif") return false
  const longEdge = Math.max(info.width, info.height)
  if (longEdge > MAX_IMAGE_LONG_EDGE) return true
  if (info.encodedBytes > MAX_ENCODED_IMAGE_BYTES) return true
  return false
}

/**
 * Compute aspect-ratio-preserving target dimensions that fit the long-edge cap.
 * Never upscales (a smaller image is returned unchanged). Floors each edge to
 * at least 1px to avoid a zero-area canvas on degenerate ultra-wide inputs.
 * Pure.
 */
export const computeTargetDimensions = (width: number, height: number): TargetDimensions => {
  const longEdge = Math.max(width, height)
  if (longEdge <= MAX_IMAGE_LONG_EDGE) {
    return { width, height }
  }
  const scale = MAX_IMAGE_LONG_EDGE / longEdge
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/**
 * Downscale a base64 image if it exceeds the caps, else return it untouched.
 *
 * Contract preserved: returns `{ data, mediaType, byteSize }` exactly like the
 * input, so `MessageBubble` / wire consumers are unchanged. Guarantees:
 *   - non-triggering images are returned byte-identical (no decode/encode).
 *   - any decode/encode failure falls back to the ORIGINAL payload — a paste
 *     must never crash because scaling failed.
 *   - the re-encoded result is only kept if it is actually *smaller*; a larger
 *     re-encode (e.g. PNG→PNG that grew) is discarded in favor of the original.
 */
export const downscaleBase64Image = async (
  payload: Base64ImagePayload,
  deps: ImageDownscaleDeps,
): Promise<Base64ImagePayload> => {
  // We cannot know pixel dimensions without decoding, and a small-BYTE image can
  // still be a huge-PIXEL one (e.g. a solid-color 5K screenshot) whose DOM decode
  // cost we must contain. So we always decode to inspect dimensions. Decode
  // failure is a safe passthrough — a paste must never crash because scaling
  // failed; the 20MB inline hard cap remains as the byte backstop.
  let decoded: ImageDecodeResult
  try {
    decoded = await deps.decode(payload.data, payload.mediaType)
  } catch {
    return payload
  }
  if (
    !shouldDownscale({
      width: decoded.width,
      height: decoded.height,
      mediaType: payload.mediaType,
      encodedBytes: payload.byteSize,
    })
  ) {
    return payload
  }
  return reencode(payload, decoded, deps)
}

const reencode = async (
  payload: Base64ImagePayload,
  decoded: ImageDecodeResult,
  deps: ImageDownscaleDeps,
): Promise<Base64ImagePayload> => {
  const target = computeTargetDimensions(decoded.width, decoded.height)
  let scaled: Base64ImagePayload
  try {
    scaled = await deps.encodeScaled(payload.data, target, {
      quality: DOWNSCALE_ENCODE_QUALITY,
      sourceMediaType: payload.mediaType,
    })
  } catch {
    return payload
  }
  // Only keep the re-encode if it actually shrank the payload; never regress.
  return scaled.byteSize < payload.byteSize ? scaled : payload
}

// ---------------------------------------------------------------------------
// Browser deps — real decode + canvas encode. No-op-safe outside the DOM.
// ---------------------------------------------------------------------------

const base64ToArrayBuffer = (data: string): ArrayBuffer => {
  const binary = atob(data)
  const buffer = new ArrayBuffer(binary.length)
  const bytes = new Uint8Array(buffer)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return buffer
}

const blobToBase64 = async (blob: Blob): Promise<string> => {
  const buffer = await blob.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ""
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/**
 * Whether the browser image APIs needed for downscaling are present. When
 * false (node/vitest, headless), callers should skip downscaling entirely.
 */
export const isBrowserDownscaleSupported = (): boolean =>
  typeof createImageBitmap === "function" &&
  typeof document !== "undefined" &&
  typeof HTMLCanvasElement !== "undefined"

/**
 * Build the real browser-backed downscale deps. Callers should gate on
 * `isBrowserDownscaleSupported()` before use; if invoked without the APIs the
 * decode/encode will throw, which `downscaleBase64Image` treats as a safe
 * fallback to the original payload.
 */
export const createBrowserDownscaleDeps = (): ImageDownscaleDeps => ({
  decode: async (data, mediaType) => {
    const blob = new Blob([base64ToArrayBuffer(data)], { type: mediaType })
    const bitmap = await createImageBitmap(blob)
    try {
      return { width: bitmap.width, height: bitmap.height }
    } finally {
      bitmap.close()
    }
  },
  encodeScaled: async (data, target, opts) => {
    const blob = new Blob([base64ToArrayBuffer(data)], {
      type: opts.sourceMediaType,
    })
    const bitmap = await createImageBitmap(blob)
    try {
      const canvas = document.createElement("canvas")
      canvas.width = target.width
      canvas.height = target.height
      const ctx = canvas.getContext("2d")
      if (ctx === null) {
        throw new Error("2d canvas context unavailable")
      }
      ctx.drawImage(bitmap, 0, 0, target.width, target.height)

      // Preserve transparency for PNG sources (canvas→JPEG would flatten alpha
      // onto black). For opaque sources prefer WEBP (smaller than JPEG at equal
      // quality, wide browser support) and fall back to JPEG.
      const outType = chooseOutputType(opts.sourceMediaType)
      const outBlob = await canvasToBlob(canvas, outType, opts.quality)
      if (outBlob === null) {
        throw new Error("canvas encode returned null")
      }
      return {
        data: await blobToBase64(outBlob),
        mediaType: outBlob.type || outType,
        byteSize: outBlob.size,
      }
    } finally {
      bitmap.close()
    }
  },
})

const chooseOutputType = (sourceMediaType: string): string => {
  // PNG / GIF may carry transparency — keep PNG to avoid alpha flattening.
  if (sourceMediaType === "image/png" || sourceMediaType === "image/gif") {
    return "image/png"
  }
  return "image/webp"
}

const canvasToBlob = (
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> =>
  new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality)
  })
