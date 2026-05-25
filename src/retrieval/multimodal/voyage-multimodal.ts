/**
 * Voyage AI multi-modal embedder adapter — ADR-0276.
 *
 *   POST https://api.voyageai.com/v1/multimodalembeddings
 *   Headers: Authorization: Bearer ${VOYAGE_API_KEY}
 *   Body: {
 *     model:  "voyage-multimodal-3",
 *     inputs: [{ content: [ { type: "text"|"image_base64", text|image_base64 } ] }]
 *   }
 *   Resp: { data: [{ embedding: number[] }], usage?: { ... } }
 *
 * voyage-multimodal-3 supports text + image. Audio is NOT supported at the
 * API level — `audio` input returns `unsupported-mime`.
 *
 * Transport: 4xx (auth) folds into `missing-api-key`. 429 THROWS
 * `Error("rate-limited")`. Other 5xx / network failures THROW raw. The
 * 6-arm `MMEmbedError` is the input/config domain only.
 */
import { err, ok, type Result } from "@/shared"
import type { MultiModalEmbedder } from "./port"
import type { EmbedResult, ImageBlob, MMCapabilities, MMEmbedError, MultiModalInput } from "./types"

const DEFAULT_MODEL = "voyage-multimodal-3"
const DEFAULT_BASE = "https://api.voyageai.com/v1"
const DEFAULT_DIM = 1024
const DEFAULT_MAX_IMAGE = 8 * 1024 * 1024 // 8 MiB
const DEFAULT_MAX_AUDIO = 0 // audio unsupported at the API; cap=0 keeps tests honest

const ALLOWED_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"])

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

export interface VoyageMultiModalOptions {
  readonly apiKey?: string | undefined
  readonly model?: string
  readonly baseURL?: string
  readonly dim?: number
  readonly maxImageBytes?: number
  readonly fetchImpl?: FetchFn
}

interface VoyageResp {
  readonly data?: ReadonlyArray<{ readonly embedding?: readonly number[] }>
  readonly usage?: { readonly total_tokens?: number }
}

const toBase64 = (b: Uint8Array): string => Buffer.from(b).toString("base64")

const validateImage = (blob: ImageBlob, maxImageBytes: number): MMEmbedError | null => {
  if (blob.bytes.length === 0) return { kind: "empty-input" }
  if (!ALLOWED_IMAGE_MIMES.has(blob.mime)) return { kind: "unsupported-mime", mime: blob.mime }
  if (blob.bytes.length > maxImageBytes) {
    return { kind: "image-too-large", bytes: blob.bytes.length, cap: maxImageBytes }
  }
  return null
}

/** Single-shot input validation — keeps the `embed()` body inside the
 * cognitive-complexity budget. Returns the first error, or null. */
const validateInput = (input: MultiModalInput, maxImageBytes: number): MMEmbedError | null => {
  if (input.kind === "audio") return { kind: "unsupported-mime", mime: input.blob.mime }
  if (input.kind === "text") return input.text.length === 0 ? { kind: "empty-input" } : null
  // image
  return validateImage(input.blob, maxImageBytes)
}

const buildBody = (model: string, input: MultiModalInput): unknown => {
  if (input.kind === "text") {
    return {
      model,
      inputs: [{ content: [{ type: "text", text: input.text }] }],
    }
  }
  // image (audio rejected before this point)
  return {
    model,
    inputs: [
      {
        content: [
          {
            type: "image_base64",
            image_base64: `data:${input.blob.mime};base64,${toBase64(input.blob.bytes)}`,
          },
        ],
      },
    ],
  }
}

const decode = (parsed: VoyageResp): Result<number[][], MMEmbedError> => {
  const data = parsed.data
  if (data === undefined || !Array.isArray(data) || data.length === 0) {
    // Treat as auth-style failure — caller should re-check key/model.
    return err({ kind: "missing-api-key", provider: "voyage" })
  }
  const vectors: number[][] = []
  for (const d of data) {
    const v = d.embedding
    if (v === undefined || !Array.isArray(v)) {
      return err({ kind: "missing-api-key", provider: "voyage" })
    }
    vectors.push([...v])
  }
  return ok(vectors)
}

const buildInit = (body: unknown, apiKey: string, signal: AbortSignal | undefined): RequestInit => {
  const init: RequestInit = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  }
  if (signal !== undefined) (init as { signal?: AbortSignal }).signal = signal
  return init
}

/** Classify HTTP status into a MMEmbedError arm or throw for transport. */
const classifyStatus = async (res: Response): Promise<MMEmbedError> => {
  if (res.status === 429) {
    // Drain so the connection can be reused, then throw — transport class.
    await res.text().catch(() => "")
    throw new Error("rate-limited")
  }
  if (res.status === 401 || res.status === 403 || (res.status >= 400 && res.status < 500)) {
    await res.text().catch(() => "")
    return { kind: "missing-api-key", provider: "voyage" }
  }
  // 5xx — transport
  const body = await res.text().catch(() => "")
  throw new Error(`voyage http ${res.status}: ${body}`)
}

export const createVoyageMultiModalEmbedder = (
  opts: VoyageMultiModalOptions,
): MultiModalEmbedder => {
  const model = opts.model ?? DEFAULT_MODEL
  const baseURL = opts.baseURL ?? DEFAULT_BASE
  const dim = opts.dim ?? DEFAULT_DIM
  const maxImageBytes = opts.maxImageBytes ?? DEFAULT_MAX_IMAGE
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchFn)
  const modelTag = `voyage:${model}`

  const caps: MMCapabilities = {
    dim,
    supportedModalities: ["text", "image"],
    maxImageBytes,
    maxAudioBytes: DEFAULT_MAX_AUDIO,
    modelTag,
  }

  return {
    async embed(
      input: MultiModalInput,
      callOpts?: { readonly signal?: AbortSignal },
    ): Promise<Result<EmbedResult, MMEmbedError>> {
      const apiKey = opts.apiKey
      if (apiKey === undefined || apiKey === "") {
        return err({ kind: "missing-api-key", provider: "voyage" })
      }
      const bad = validateInput(input, maxImageBytes)
      if (bad !== null) return err(bad)

      const res = await fetchImpl(
        `${baseURL}/multimodalembeddings`,
        buildInit(buildBody(model, input), apiKey, callOpts?.signal),
      )
      if (!res.ok) return err(await classifyStatus(res))
      const parsed = (await res.json()) as VoyageResp
      const decoded = decode(parsed)
      if (!decoded.ok) return decoded
      const tokenCount = parsed.usage?.total_tokens
      const result: EmbedResult =
        tokenCount === undefined
          ? { vectors: decoded.value, modelTag }
          : { vectors: decoded.value, modelTag, tokenCount }
      return ok(result)
    },
    async capabilities(): Promise<MMCapabilities> {
      return caps
    },
  }
}
