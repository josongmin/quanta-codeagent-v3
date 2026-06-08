/**
 * `image_gen` provider port (H14a, jun-3-misc §3) — the closed-port seam for
 * the ONE network call the image-generation tool makes. Mirrors the
 * `WebSearchProvider` / `readImageUrlTool({fetcher})` DI posture: the tool
 * itself is provider-agnostic; a concrete adapter (default = OpenAI images
 * endpoint) is injected by the composition root, and tests inject a fake.
 *
 * Slice posture (RFC §3.1):
 *   - This file imports ONLY `@/shared` (`errMessage`). It does NOT import
 *     `@/llm`, `@/agent`, `@/permission`, `@/storage`, or read `process.env`
 *     (the slice-boundary invariant: only `runtime-config.ts` touches env).
 *   - Key resolution is NOT done here by reading env — the composition root
 *     resolves the OpenAI key from `runtimeConfig()` / the same `EnvLikeDecl`
 *     the LLM factory uses (`OPENAI_API_KEY`) and passes it in as `apiKey`.
 *     An ABSENT key is a typed `kind:"no_key"` outcome, never a throw/crash.
 *   - The adapter binds `globalThis.fetch` by default (injectable as a test
 *     seam), exactly like `webFetchTool` / `readImageUrlTool`.
 *
 * Provider contract: the port returns base64-encoded image bytes (the OpenAI
 * images API returns `data[].b64_json`). The tool decodes + writes through the
 * FS-jail; the port never touches the filesystem.
 */

import { errMessage } from "@/shared"

/** Image output format the provider emits. PNG is the default (lossless,
 *  alpha-capable). Closed union — extending requires a port-version bump. */
export type ImageGenFormat = "png" | "jpeg" | "webp"

/** §5.2 (long-tail) — model-friendly output shape, independent of raw pixels.
 *  A provider-agnostic intent the adapter maps onto its native size vocabulary
 *  (the OpenAI adapter resolves it to a concrete `size`). `auto` ⇒ the provider
 *  decides (byte-identical to omitting it). Closed union. */
export type ImageAspectRatio = "1:1" | "16:9" | "9:16" | "4:3" | "3:4" | "auto"

/** One generated image: base64 bytes + the IANA media type they decode to. */
export interface GeneratedImage {
  /** Base64-encoded image bytes, NO `data:` URI prefix. */
  readonly b64: string
  /** IANA media type — `image/png` | `image/jpeg` | `image/webp`. */
  readonly mediaType: string
}

/** Closed request the tool hands the port. The port maps this onto whatever
 *  the concrete provider's wire shape is (OpenAI: `/v1/images/{generations,
 *  edits}`). `referenceImages` is non-empty ONLY for `mode:"edit"`. */
export interface ImageGenRequest {
  readonly mode: "generate" | "edit"
  readonly prompt: string
  /** `auto` or `WIDTHxHEIGHT`. The tool validates the literal before the call.
   *  AUTHORITATIVE over {@link aspectRatio}: an explicit `WIDTHxHEIGHT` here is
   *  used verbatim; the adapter only consults `aspectRatio` when `size` is
   *  `auto`. */
  readonly size: string
  /** §5.2 — model-friendly output shape. `auto` (default) ⇒ the adapter leaves
   *  `size` untouched (byte-identical legacy). When `size` is `auto` and this is
   *  a concrete ratio, the adapter resolves it to a provider-supported size. */
  readonly aspectRatio: ImageAspectRatio
  readonly quality: "low" | "medium" | "high" | "auto"
  readonly n: number
  readonly format: ImageGenFormat
  /** Output transparency behavior (`transparent` | `opaque` | `auto`). */
  readonly background: "transparent" | "opaque" | "auto"
  /** Edit-mode reference image bytes (base64, no prefix) + media type. Empty
   *  for `mode:"generate"`. */
  readonly referenceImages: readonly GeneratedImage[]
}

/** Typed provider outcome — NEVER throws past the adapter boundary. */
export type ImageGenOutcome =
  | { readonly kind: "ok"; readonly images: readonly GeneratedImage[] }
  /** No API key resolved at the composition root ⇒ the tool surfaces a typed
   *  failure (not a crash). */
  | { readonly kind: "no_key" }
  /** Any provider/transport error (non-2xx, network, malformed body). `message`
   *  is the model-visible safe text. */
  | { readonly kind: "error"; readonly message: string }

/** The closed port the tool consumes. The implementation owns the HTTP call
 *  and MUST honor the abort `signal`. An implementation that throws is caught
 *  at the tool boundary — the tool never lets a provider error escape. */
export interface ImageGenPort {
  generate(req: ImageGenRequest, signal?: AbortSignal): Promise<ImageGenOutcome>
}

/** Options for the default OpenAI-images adapter. */
export interface OpenAiImagePortOptions {
  /** Resolved API key. Absent/empty ⇒ the adapter returns `{kind:"no_key"}`
   *  WITHOUT making a network call. The composition root resolves this from the
   *  same `OPENAI_API_KEY` source the LLM factory uses — NEVER hardcoded. */
  readonly apiKey?: string
  /** Injected fetcher (test seam). Default = `globalThis.fetch`. */
  readonly fetcher?: typeof fetch
  /** Endpoint base (`OPENAI_BASE_URL` override). Default = the public API. */
  readonly baseUrl?: string
  /** GPT-image model id. Default `gpt-image-1` (the public images model). */
  readonly model?: string
}

const DEFAULT_OPENAI_BASE = "https://api.openai.com/v1"
const DEFAULT_IMAGE_MODEL = "gpt-image-1"

/** Map a provider `output_format` onto the IANA media type. */
const mediaTypeFor = (format: ImageGenFormat): string =>
  format === "jpeg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png"

/** §5.2 — concrete gpt-image-1 sizes for each aspect ratio. The model only
 *  supports a fixed size set (`1024x1024`, `1536x1024`, `1024x1536`, `auto`),
 *  so non-square ratios map onto the nearest supported landscape/portrait size:
 *  16:9 & 4:3 → landscape `1536x1024`; 9:16 & 3:4 → portrait `1024x1536`. */
const ASPECT_TO_SIZE: Readonly<Record<Exclude<ImageAspectRatio, "auto">, string>> = {
  "1:1": "1024x1024",
  "16:9": "1536x1024",
  "4:3": "1536x1024",
  "9:16": "1024x1536",
  "3:4": "1024x1536",
}

/** Resolve the effective provider `size`. An explicit `WIDTHxHEIGHT` in
 *  `req.size` is AUTHORITATIVE; `aspectRatio` is consulted only when `size` is
 *  `auto`. `aspectRatio:"auto"` (or absent) ⇒ `size` is returned untouched, so
 *  a request that set neither yields `auto` exactly as before (byte-identical). */
const effectiveSize = (req: ImageGenRequest): string => {
  if (req.size !== "auto") return req.size
  if (req.aspectRatio === "auto") return req.size
  return ASPECT_TO_SIZE[req.aspectRatio]
}

/** Shape of the OpenAI images response we read (`data[].b64_json`). Narrow,
 *  defensive parse — anything else maps to a typed error. */
interface OpenAiImagesResponse {
  readonly data?: ReadonlyArray<{ readonly b64_json?: string }>
}

/** Build the JSON body for a `generations` request. The `edits` endpoint is
 *  multipart, handled separately. */
const generationsBody = (req: ImageGenRequest, model: string): Record<string, unknown> => ({
  model,
  prompt: req.prompt,
  n: req.n,
  // §5.2 — explicit `size` is authoritative; `aspectRatio` resolves only when
  // `size` is `auto`. Neither set ⇒ `auto` exactly as before.
  size: effectiveSize(req),
  quality: req.quality,
  output_format: req.format,
  // `background` only meaningful when the model supports transparency; sent
  // verbatim — an unsupported value surfaces as a provider error (typed).
  background: req.background,
})

/** Extract base64 images from a parsed response or return a typed error. */
const readImages = (body: OpenAiImagesResponse, format: ImageGenFormat): ImageGenOutcome => {
  const data = body.data
  if (data === undefined || data.length === 0) {
    return { kind: "error", message: "provider returned no image data" }
  }
  const images: GeneratedImage[] = []
  for (const item of data) {
    const b64 = item.b64_json
    if (typeof b64 !== "string" || b64.length === 0) {
      return { kind: "error", message: "provider image item missing b64_json" }
    }
    images.push({ b64, mediaType: mediaTypeFor(format) })
  }
  return { kind: "ok", images }
}

/** Build the multipart `RequestInit` for an `edit` request (image parts +
 *  fields). `image[]` (repeated) is how GPT-image edits accept multiple inputs. */
const buildEditInit = (
  req: ImageGenRequest,
  model: string,
  apiKey: string,
  signal?: AbortSignal,
): RequestInit => {
  const form = new FormData()
  form.set("model", model)
  form.set("prompt", req.prompt)
  form.set("n", String(req.n))
  // §5.2 — same size resolution as the generations path (aspectRatio→size).
  form.set("size", effectiveSize(req))
  form.set("quality", req.quality)
  form.set("output_format", req.format)
  req.referenceImages.forEach((img, i) => {
    const bytes = Buffer.from(img.b64, "base64")
    form.set(
      "image[]",
      new Blob([new Uint8Array(bytes)], { type: img.mediaType }),
      `reference-${i}.png`,
    )
  })
  return {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
    ...(signal !== undefined ? { signal } : {}),
  }
}

/** Build the JSON `RequestInit` for a `generations` request. */
const buildGenerateInit = (
  req: ImageGenRequest,
  model: string,
  apiKey: string,
  signal?: AbortSignal,
): RequestInit => ({
  method: "POST",
  headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
  body: JSON.stringify(generationsBody(req, model)),
  ...(signal !== undefined ? { signal } : {}),
})

/** Map a non-2xx response to a typed error (draining a bounded body snippet). */
const errorFromResponse = async (res: Response): Promise<ImageGenOutcome> => {
  let detail = ""
  try {
    detail = (await res.text()).slice(0, 500)
  } catch {
    detail = ""
  }
  return {
    kind: "error",
    message: `provider error: HTTP ${res.status} ${res.statusText}${detail !== "" ? ` — ${detail}` : ""}`,
  }
}

/** Default OpenAI-images {@link ImageGenPort}. Binds `globalThis.fetch` unless
 *  a fake is injected. NEVER throws: every failure (no key, network, non-2xx,
 *  malformed body) becomes a typed {@link ImageGenOutcome}. */
export const openAiImagePort = (options: OpenAiImagePortOptions = {}): ImageGenPort => {
  const fetcher = options.fetcher ?? globalThis.fetch
  const base = (options.baseUrl ?? DEFAULT_OPENAI_BASE).replace(/\/+$/, "")
  const model = options.model ?? DEFAULT_IMAGE_MODEL

  return {
    async generate(req: ImageGenRequest, signal?: AbortSignal): Promise<ImageGenOutcome> {
      const apiKey = options.apiKey
      if (apiKey === undefined || apiKey === "") return { kind: "no_key" }

      // The `edit` endpoint is multipart/form-data (image parts); `generate`
      // is JSON. Build the right request per mode.
      const isEdit = req.mode === "edit"
      const url = `${base}/images/${isEdit ? "edits" : "generations"}`
      const init = isEdit
        ? buildEditInit(req, model, apiKey, signal)
        : buildGenerateInit(req, model, apiKey, signal)

      let res: Response
      try {
        res = await fetcher(url, init)
      } catch (e) {
        return { kind: "error", message: `image request failed: ${errMessage(e)}` }
      }
      if (!res.ok) return errorFromResponse(res)
      let parsed: OpenAiImagesResponse
      try {
        parsed = (await res.json()) as OpenAiImagesResponse
      } catch (e) {
        return { kind: "error", message: `malformed provider response: ${errMessage(e)}` }
      }
      return readImages(parsed, req.format)
    },
  }
}
