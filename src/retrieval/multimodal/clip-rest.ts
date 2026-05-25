/**
 * Generic CLIP-style multi-modal embedder REST adapter — ADR-0276.
 *
 * Targets any self-hosted CLIP-style endpoint that accepts a single
 * `multipart/form-data` POST with:
 *   - `kind`: "text" | "image" | "audio"
 *   - `text` (string) for text
 *   - `file` (binary) for image / audio, with form-part `content-type`
 *     carrying the original mime
 *   - `mime` (string echoed) for downstream routing
 *
 * Response: JSON `{ embedding: number[] }`.
 *
 * Multipart body is built manually to keep the adapter dep-free
 * (`fetch` has good `FormData` support in Bun/Node 18+, but we use a
 * tiny hand-rolled multipart writer so the wire shape is byte-identical
 * across runtimes and trivially mockable in tests).
 *
 * `endpoint` not supplied (undefined / empty) → `endpoint-missing` before
 * any I/O.
 */
import { err, ok, type Result } from "@/shared"
import type { MultiModalEmbedder } from "./port"
import type { EmbedResult, MMCapabilities, MMEmbedError, MultiModalInput } from "./types"

const DEFAULT_DIM = 512 // CLIP ViT-B/32 default
const DEFAULT_MAX_IMAGE = 8 * 1024 * 1024
const DEFAULT_MAX_AUDIO = 16 * 1024 * 1024

const ALLOWED_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/bmp",
])
const ALLOWED_AUDIO_MIMES = new Set([
  "audio/wav",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "audio/flac",
])

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

export interface ClipRestOptions {
  readonly endpoint?: string | undefined
  readonly modelTag?: string
  readonly dim?: number
  readonly maxImageBytes?: number
  readonly maxAudioBytes?: number
  readonly fetchImpl?: FetchFn
  readonly headers?: Record<string, string>
}

interface ClipResp {
  readonly embedding?: readonly number[]
}

const validate = (
  input: MultiModalInput,
  maxImage: number,
  maxAudio: number,
): MMEmbedError | null => {
  if (input.kind === "text") {
    return input.text.length === 0 ? { kind: "empty-input" } : null
  }
  if (input.kind === "image") {
    if (input.blob.bytes.length === 0) return { kind: "empty-input" }
    if (!ALLOWED_IMAGE_MIMES.has(input.blob.mime)) {
      return { kind: "unsupported-mime", mime: input.blob.mime }
    }
    if (input.blob.bytes.length > maxImage) {
      return { kind: "image-too-large", bytes: input.blob.bytes.length, cap: maxImage }
    }
    return null
  }
  // audio
  if (input.blob.bytes.length === 0) return { kind: "empty-input" }
  if (!ALLOWED_AUDIO_MIMES.has(input.blob.mime)) {
    return { kind: "unsupported-mime", mime: input.blob.mime }
  }
  if (input.blob.bytes.length > maxAudio) {
    return { kind: "audio-too-large", bytes: input.blob.bytes.length, cap: maxAudio }
  }
  return null
}

const BOUNDARY = "----quanta-mm-clip-boundary-jK9p2nLqR3"

const encoder = new TextEncoder()

const concatBytes = (parts: readonly Uint8Array[]): Uint8Array => {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

const textPart = (name: string, value: string): Uint8Array =>
  encoder.encode(
    `--${BOUNDARY}\r\n` + `content-disposition: form-data; name="${name}"\r\n\r\n` + `${value}\r\n`,
  )

const binaryPart = (
  name: string,
  mime: string,
  filename: string,
  bytes: Uint8Array,
): Uint8Array => {
  const header = encoder.encode(
    `--${BOUNDARY}\r\n` +
      `content-disposition: form-data; name="${name}"; filename="${filename}"\r\n` +
      `content-type: ${mime}\r\n\r\n`,
  )
  const trailer = encoder.encode("\r\n")
  return concatBytes([header, bytes, trailer])
}

const closer = (): Uint8Array => encoder.encode(`--${BOUNDARY}--\r\n`)

const buildMultipart = (input: MultiModalInput): Uint8Array => {
  if (input.kind === "text") {
    return concatBytes([textPart("kind", "text"), textPart("text", input.text), closer()])
  }
  if (input.kind === "image") {
    return concatBytes([
      textPart("kind", "image"),
      textPart("mime", input.blob.mime),
      binaryPart("file", input.blob.mime, "blob.bin", input.blob.bytes),
      closer(),
    ])
  }
  // audio
  return concatBytes([
    textPart("kind", "audio"),
    textPart("mime", input.blob.mime),
    binaryPart("file", input.blob.mime, "blob.bin", input.blob.bytes),
    closer(),
  ])
}

const buildInit = (
  body: Uint8Array,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
): RequestInit => {
  const init: RequestInit = {
    method: "POST",
    headers: {
      ...headers,
      "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
    },
    body,
  }
  if (signal !== undefined) (init as { signal?: AbortSignal }).signal = signal
  return init
}

const classifyStatus = async (res: Response): Promise<MMEmbedError> => {
  if (res.status === 429) {
    await res.text().catch(() => "")
    throw new Error("rate-limited")
  }
  if (res.status >= 400 && res.status < 500) {
    await res.text().catch(() => "")
    return { kind: "missing-api-key", provider: "clip" }
  }
  const body = await res.text().catch(() => "")
  throw new Error(`clip http ${res.status}: ${body}`)
}

export const createClipRestEmbedder = (opts: ClipRestOptions): MultiModalEmbedder => {
  const endpoint = opts.endpoint
  const dim = opts.dim ?? DEFAULT_DIM
  const maxImageBytes = opts.maxImageBytes ?? DEFAULT_MAX_IMAGE
  const maxAudioBytes = opts.maxAudioBytes ?? DEFAULT_MAX_AUDIO
  const modelTag = opts.modelTag ?? "clip:rest"
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchFn)
  const headers = opts.headers ?? {}

  const caps: MMCapabilities = {
    dim,
    supportedModalities: ["text", "image", "audio"],
    maxImageBytes,
    maxAudioBytes,
    modelTag,
  }

  return {
    async embed(
      input: MultiModalInput,
      callOpts?: { readonly signal?: AbortSignal },
    ): Promise<Result<EmbedResult, MMEmbedError>> {
      if (endpoint === undefined || endpoint === "") {
        return err({ kind: "endpoint-missing" })
      }
      const bad = validate(input, maxImageBytes, maxAudioBytes)
      if (bad !== null) return err(bad)

      const body = buildMultipart(input)
      const res = await fetchImpl(endpoint, buildInit(body, headers, callOpts?.signal))
      if (!res.ok) return err(await classifyStatus(res))
      const parsed = (await res.json()) as ClipResp
      const v = parsed.embedding
      if (v === undefined || !Array.isArray(v)) {
        // Treat a malformed payload as a credentials/wiring issue the user
        // can fix (mirrors voyage adapter).
        return err({ kind: "missing-api-key", provider: "clip" })
      }
      return ok({ vectors: [[...v]], modelTag })
    },
    async capabilities(): Promise<MMCapabilities> {
      return caps
    },
  }
}
