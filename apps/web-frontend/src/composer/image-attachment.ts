/**
 * Image attachment domain — pure types, constants, helpers.
 *
 * Single source of truth for the composer's image-attachment subsystem
 * (file picker, clipboard paste, active-monitor hotkey). The React hook
 * in `./use-image-attachment.ts` consumes these; nothing here imports
 * from React or the WS layer.
 *
 * Validation contract — every trigger must funnel through `normalizeFile`
 * or `normalizeHotkeyPng` so MIME / size caps are applied uniformly. The
 * previous shape had the hotkey path bypass validation (no size cap on
 * 5K-monitor captures); recombining via this module closes that gap.
 */

import type { ImageBlock } from "../types/protocol"
import {
  type Base64ImagePayload,
  createBrowserDownscaleDeps,
  downscaleBase64Image,
  type ImageDownscaleDeps,
  isBrowserDownscaleSupported,
} from "./image-downscale"

export const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024
/** Soft cap on accumulated attachments per turn. Prevents foot-guns when
 *  the user repeatedly fires the active-monitor hotkey — each capture can
 *  push the total payload past the LLM provider's request size limit. */
export const MAX_PENDING_IMAGES = 8

export const SUPPORTED_IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
])

/** Image attachment waiting to be attached to the next turn. */
export interface PendingImageAttachment {
  readonly data: string
  readonly mediaType: string
  readonly byteSize: number
  readonly title: string
  readonly subtitle: string
  readonly previewAlt: string
}

export type AttachmentSource = "picker" | "paste" | "hotkey"

export type NormalizeResult =
  | { readonly ok: true; readonly attachment: PendingImageAttachment }
  | { readonly ok: false; readonly error: string }

/**
 * Resolve the downscale deps to use. In the browser (paste/picker path) we use
 * the real canvas-backed deps; when the DOM image APIs are absent (node tests,
 * headless) we return `undefined` so the image is stored verbatim. Callers may
 * inject deps directly for testing. Downscale failures fall back to the
 * original payload inside `downscaleBase64Image`, so this never throws.
 */
const resolveDownscaleDeps = (injected?: ImageDownscaleDeps): ImageDownscaleDeps | undefined => {
  if (injected !== undefined) return injected
  return isBrowserDownscaleSupported() ? createBrowserDownscaleDeps() : undefined
}

const maybeDownscale = async (
  payload: Base64ImagePayload,
  deps: ImageDownscaleDeps | undefined,
): Promise<Base64ImagePayload> => {
  if (deps === undefined) return payload
  return downscaleBase64Image(payload, deps)
}

export const normalizeFile = async (
  file: File,
  source: "picker" | "paste",
  downscaleDeps?: ImageDownscaleDeps,
): Promise<NormalizeResult> => {
  const type = file.type.toLowerCase()
  const fileName = normalizedFileName(file)
  if (!SUPPORTED_IMAGE_MEDIA_TYPES.has(type)) {
    return {
      ok: false,
      error: `unsupported image type: ${type.length > 0 ? type : "(unknown)"}`,
    }
  }
  if (file.size > MAX_INLINE_IMAGE_BYTES) {
    return {
      ok: false,
      error: `image is too large: ${formatMegabytes(file.size)} MB (max ${formatMegabytes(MAX_INLINE_IMAGE_BYTES)} MB)`,
    }
  }
  try {
    const rawData = await readFileAsBase64(file)
    const payload = await maybeDownscale(
      { data: rawData, mediaType: type, byteSize: file.size },
      resolveDownscaleDeps(downscaleDeps),
    )
    return {
      ok: true,
      attachment: {
        data: payload.data,
        mediaType: payload.mediaType,
        byteSize: payload.byteSize,
        title:
          fileName.length > 0 ? fileName : source === "paste" ? "Pasted image" : "Selected image",
        subtitle: `${describeImageSource(source)} · ${formatKilobytes(payload.byteSize)} KB · attached to next turn`,
        previewAlt: fileName.length > 0 ? fileName : "Image attachment preview",
      },
    }
  } catch (error) {
    return {
      ok: false,
      error: `failed to read image: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

export interface HotkeyImagePayload {
  readonly kind: "quanta:hotkey-image-capture"
  readonly pngBase64: string
  readonly monitorName: string
  readonly capturedAtMs: number
  readonly byteSize: number
}

export const isHotkeyImagePayload = (value: unknown): value is HotkeyImagePayload => {
  if (value === null || typeof value !== "object") return false
  const obj = value as Record<string, unknown>
  return (
    obj.kind === "quanta:hotkey-image-capture" &&
    typeof obj.pngBase64 === "string" &&
    typeof obj.monitorName === "string" &&
    typeof obj.capturedAtMs === "number" &&
    typeof obj.byteSize === "number"
  )
}

export const normalizeHotkeyPng = async (
  payload: HotkeyImagePayload,
  downscaleDeps?: ImageDownscaleDeps,
): Promise<NormalizeResult> => {
  if (payload.byteSize > MAX_INLINE_IMAGE_BYTES) {
    return {
      ok: false,
      error: `screen capture is too large: ${formatMegabytes(payload.byteSize)} MB (max ${formatMegabytes(MAX_INLINE_IMAGE_BYTES)} MB)`,
    }
  }
  const monitorLabel = payload.monitorName.length > 0 ? payload.monitorName : "Active monitor"
  // Active-monitor captures are the largest offenders (5K PNGs). Downscale
  // before it enters the queue; failures fall back to the original bytes.
  const scaled = await maybeDownscale(
    {
      data: payload.pngBase64,
      mediaType: "image/png",
      byteSize: payload.byteSize,
    },
    resolveDownscaleDeps(downscaleDeps),
  )
  return {
    ok: true,
    attachment: {
      data: scaled.data,
      mediaType: scaled.mediaType,
      byteSize: scaled.byteSize,
      title: monitorLabel,
      subtitle: `${monitorLabel} · ${formatKilobytes(scaled.byteSize)} KB · attached to next turn`,
      previewAlt: `Screenshot from ${monitorLabel}`,
    },
  }
}

export const toImageBlocks = (
  pendings: readonly PendingImageAttachment[],
): readonly ImageBlock[] | undefined => {
  if (pendings.length === 0) return undefined
  return pendings.map((p) => ({
    type: "image" as const,
    mediaType: p.mediaType,
    data: p.data,
  }))
}

const describeImageSource = (source: "picker" | "paste"): string =>
  source === "paste" ? "pasted from clipboard" : "selected from disk"

const normalizedFileName = (file: File): string => {
  const raw = (file as File & { name?: unknown }).name
  return typeof raw === "string" ? raw.trim() : ""
}

const formatKilobytes = (bytes: number): string => Math.max(1, Math.round(bytes / 1024)).toString()

const formatMegabytes = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1)

const readFileAsBase64 = async (file: File): Promise<string> => {
  // `File.arrayBuffer()` is standard in browsers and modern Node — used
  // instead of `FileReader` so the same path works in vitest's node env.
  const buffer = await file.arrayBuffer()
  return arrayBufferToBase64(buffer)
}

const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer)
  let binary = ""
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}
