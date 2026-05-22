import { readFileSync, statSync } from "node:fs"
import { extname } from "node:path"
import type { ImageBlock } from "@/llm"

/**
 * CLI image loader (ADR-0083 multi-modal) — read an image file off disk into
 * a base64 {@link ImageBlock} the LLM adapters serialize for both providers.
 *
 * - Media type is inferred from the extension and restricted to the four types
 *   BOTH OpenAI vision and Anthropic Messages accept (`png|jpeg|webp|gif`).
 *   An unsupported extension throws — no silent skip, so a typo'd `--image`
 *   path surfaces before the run starts.
 * - A 20 MB cap rejects oversized attachments (both providers reject large
 *   payloads anyway; failing fast with a clear message beats a provider 400).
 * - No `data:` prefix on `data` — the adapters add the provider-specific
 *   framing (`data:<type>;base64,…` for OpenAI, raw base64 source for
 *   Anthropic).
 */
export const SUPPORTED_IMAGE_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
})

/** 20 MB — both providers reject larger inline images; fail fast with a clear
 *  message rather than surfacing a provider 400 mid-run. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024

export const loadImageBlock = (path: string): ImageBlock => {
  const ext = extname(path).toLowerCase()
  const mediaType = SUPPORTED_IMAGE_TYPES[ext]
  if (mediaType === undefined) {
    throw new Error(
      `--image: unsupported image type "${ext || "(no extension)"}" for ${path} ` +
        `(supported: ${Object.keys(SUPPORTED_IMAGE_TYPES).join(", ")})`,
    )
  }
  const size = statSync(path).size
  if (size > MAX_IMAGE_BYTES) {
    throw new Error(
      `--image: ${path} is ${(size / 1024 / 1024).toFixed(1)}MB ` +
        `(max ${MAX_IMAGE_BYTES / 1024 / 1024}MB)`,
    )
  }
  const data = readFileSync(path).toString("base64")
  return { type: "image", data, mediaType }
}
