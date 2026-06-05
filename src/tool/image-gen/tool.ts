/**
 * `image_gen` tool (H14a, jun-3-misc §3) — text→image generation + edit.
 *
 * The FIRST binary-ARTIFACT-GENERATION tool in quanta (a NEW category: the
 * existing `read_image`/`read_image_url` slice is read-only; this WRITES image
 * files). Calls an injected {@link ImageGenPort} (default = OpenAI images
 * endpoint), decodes the base64 result, and writes it through the FS-jail to a
 * VERSIONED-sibling path (never silently overwrites — the Codex `imagegen`
 * save-path policy: `hero.png` → `hero-v2.png`).
 *
 * Mutating: `isReadOnly()` is FALSE (it writes files). No-throw: every failure
 * (schema, abort, no key, provider error, oversize, jail escape) yields a typed
 * `ok:false` {@link ToolResult}.
 *
 * Slice posture (RFC §3.1):
 *   - Imports `zod`, `@/shared` (`errMessage`), `@/llm` (the `ImageBlock` TYPE
 *     for the inline-preview channel — type-only, identical to `read_image_url`),
 *     `@/storage` (`resolveJailed` + `FsJailError` — the jail chokepoint), and
 *     its own `./port` / `./store`. NO `@/agent`, `@/permission`.
 *   - Closed-port DI: `imageGenTool({ port })` injects the provider; tests pass
 *     a fake. Default `imageGenTool()` builds the OpenAI adapter with NO key
 *     ⇒ a typed `no_key` failure (never a crash). The composition root passes
 *     a key-bound port to make it live.
 */

import { z } from "zod"
import type { ImageBlock } from "@/llm"
import { errMessage } from "@/shared"
import { FsJailError, resolveJailed } from "@/storage"
import { defineTool } from "../factory"
import type { Tool, ToolContext, ToolEvent, ToolResult } from "../types"
import {
  type GeneratedImage,
  type ImageGenFormat,
  type ImageGenPort,
  type ImageGenRequest,
  openAiImagePort,
} from "./port"
import { defaultImageWritePort, type ImageWritePort } from "./store"

/** Per-image decoded-byte cap (8 MB). A 4K PNG is comfortably under this; the
 *  cap bounds a malicious/buggy provider from writing an unbounded artifact. */
export const IMAGE_GEN_MAX_BYTES = 8 * 1024 * 1024
/** Max images per call (provider `n`). Mirrors the OpenAI images `n` ceiling. */
export const IMAGE_GEN_MAX_N = 10
/** Max versioned siblings probed before giving up (`-v2`..`-v{CAP}`). */
const VERSION_PROBE_CAP = 1000
const PROMPT_MAX = 32_000

/** `auto` or `WIDTHxHEIGHT` (digits only). The provider enforces the finer
 *  GPT-image constraints (multiple-of-16, ratio, pixel bounds); the tool only
 *  rejects structurally-malformed literals before spending a network call. */
const SIZE_RE = /^(auto|\d{2,4}x\d{2,4})$/

export const imageGenInputSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .max(PROMPT_MAX)
    .describe("Text prompt describing the image to generate"),
  outputPath: z
    .string()
    .min(1)
    .describe(
      "Destination file path (absolute or relative to cwd). Confined to the FS jail. " +
        "If the file already exists it is NEVER overwritten — a versioned sibling " +
        "(`name-v2.png`) is written instead.",
    ),
  size: z
    .string()
    .regex(SIZE_RE, "size must be `auto` or WIDTHxHEIGHT")
    .optional()
    .describe("`auto` (default) or WIDTHxHEIGHT, e.g. 1024x1024"),
  quality: z.enum(["low", "medium", "high", "auto"]).optional().describe("Quality tier"),
  n: z
    .number()
    .int()
    .positive()
    .max(IMAGE_GEN_MAX_N)
    .optional()
    .describe(`Number of variants of the SAME prompt (1-${IMAGE_GEN_MAX_N}, default 1)`),
  background: z
    .enum(["transparent", "opaque", "auto"])
    .optional()
    .describe("Output transparency behavior"),
  mode: z
    .enum(["generate", "edit"])
    .optional()
    .describe("`generate` (default) or `edit` (requires referenceImagePath)"),
  referenceImagePath: z
    .string()
    .min(1)
    .optional()
    .describe("For mode:edit — path to the image to edit (FS-jailed, read as the edit target)"),
  inlinePreview: z
    .boolean()
    .optional()
    .describe("When true, also attach the first image inline via tool_result so the model sees it"),
})
export type ImageGenInput = z.infer<typeof imageGenInputSchema>

/** Options for {@link imageGenTool}. */
export interface ImageGenToolOptions {
  /** Injected provider port. Default = key-less OpenAI adapter (yields a typed
   *  `no_key` failure until the composition root passes a key-bound port). */
  readonly port?: ImageGenPort
  /** Injected write seam (test double). Default = `@/storage`-backed bytes write. */
  readonly writePort?: ImageWritePort
}

/** Build an ok:false ToolResult with an optional typed failure. */
const errResult = (output: string, failure?: ToolResult["failure"]): ToolResult =>
  failure === undefined ? { ok: false, output } : { ok: false, output, failure }

/** Split a path into `{dir+stem, ext}` for versioned-sibling synthesis.
 *  `a/b/hero.png` → `{ base: "a/b/hero", ext: ".png" }`; a dotfile or
 *  extensionless path keeps the whole tail as the stem. */
const splitExt = (path: string): { base: string; ext: string } => {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
  const dot = path.lastIndexOf(".")
  if (dot <= slash + 1) return { base: path, ext: "" }
  return { base: path.slice(0, dot), ext: path.slice(dot) }
}

/** Compute the per-image output path, inserting a `-N` index suffix when N>1,
 *  e.g. `hero.png` → `hero.png` / `hero-2.png` / `hero-3.png`. */
const indexedPath = (path: string, index: number, total: number): string => {
  if (total <= 1) return path
  const { base, ext } = splitExt(path)
  return `${base}-${index + 1}${ext}`
}

/** Decode + cap one base64 image. Typed failure if oversize / undecodable. */
const decodeImage = (
  img: GeneratedImage,
): { kind: "ok"; bytes: Uint8Array } | { kind: "fail"; result: ToolResult } => {
  let bytes: Buffer
  try {
    bytes = Buffer.from(img.b64, "base64")
  } catch (e) {
    return { kind: "fail", result: errResult(`base64 decode failed: ${errMessage(e)}`) }
  }
  if (bytes.length === 0) {
    return { kind: "fail", result: errResult("provider returned empty image bytes") }
  }
  if (bytes.length > IMAGE_GEN_MAX_BYTES) {
    return {
      kind: "fail",
      result: errResult(`image too large: ${bytes.length} bytes (cap ${IMAGE_GEN_MAX_BYTES})`, {
        mode: "error",
        modelVisibleError: "image_over_cap",
      }),
    }
  }
  return { kind: "ok", bytes: new Uint8Array(bytes) }
}

/** Resolve a NON-overwriting jailed target for `requested`. If the jailed path
 *  is free, returns it; otherwise probes versioned siblings (`-v2`, `-v3`, …)
 *  until a free one is found. A jail escape throws `FsJailError` (caught by the
 *  caller). Returns `null` when all probes up to the cap are taken. */
const resolveVersionedTarget = async (
  requested: string,
  cwd: string,
  writePort: ImageWritePort,
): Promise<string | null> => {
  const primary = resolveJailed(requested, cwd) as string
  if (!(await writePort.exists(primary))) return primary
  const { base, ext } = splitExt(requested)
  for (let v = 2; v <= VERSION_PROBE_CAP; v++) {
    const candidate = `${base}-v${v}${ext}`
    const jailed = resolveJailed(candidate, cwd) as string
    if (!(await writePort.exists(jailed))) return jailed
  }
  return null
}

/** Build the provider request from validated input. */
const buildRequest = (
  input: ImageGenInput,
  format: ImageGenFormat,
  referenceImages: readonly GeneratedImage[],
): ImageGenRequest => ({
  mode: input.mode ?? "generate",
  prompt: input.prompt,
  size: input.size ?? "auto",
  quality: input.quality ?? "auto",
  n: input.n ?? 1,
  format,
  background: input.background ?? "auto",
  referenceImages,
})

/** Infer the output format from the requested file extension (png default). */
const formatFromPath = (path: string): ImageGenFormat => {
  const { ext } = splitExt(path)
  const e = ext.toLowerCase()
  if (e === ".jpg" || e === ".jpeg") return "jpeg"
  if (e === ".webp") return "webp"
  return "png"
}

/** Read + base64-encode the edit reference target through the FS jail. */
const loadReference = async (
  refPath: string,
  cwd: string,
): Promise<{ kind: "ok"; image: GeneratedImage } | { kind: "fail"; result: ToolResult }> => {
  let jailed: string
  try {
    jailed = resolveJailed(refPath, cwd) as string
  } catch (e) {
    if (e instanceof FsJailError) {
      return {
        kind: "fail",
        result: errResult(e.message, {
          mode: "permission_denied",
          path: refPath,
          isReadonly: true,
        }),
      }
    }
    return { kind: "fail", result: errResult(`reference path error: ${errMessage(e)}`) }
  }
  const file = Bun.file(jailed)
  if (!(await file.exists())) {
    return {
      kind: "fail",
      result: errResult(`reference image not found: ${refPath}`, {
        mode: "not_found",
        path: refPath,
      }),
    }
  }
  // NO-THROW boundary (Tool contract §2): the file can vanish or become
  // unreadable between the exists() probe and the read (TOCTOU / permissions);
  // map a read throw to a typed result instead of rejecting the iterator.
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await file.arrayBuffer())
  } catch (e) {
    return {
      kind: "fail",
      result: errResult(`reference read failed: ${errMessage(e)}`, {
        mode: "error",
        modelVisibleError: errMessage(e),
      }),
    }
  }
  if (bytes.length > IMAGE_GEN_MAX_BYTES) {
    return {
      kind: "fail",
      result: errResult(`reference image too large: ${bytes.length} bytes`, {
        mode: "error",
        modelVisibleError: "reference_over_cap",
      }),
    }
  }
  return {
    kind: "ok",
    image: { b64: Buffer.from(bytes).toString("base64"), mediaType: formatFromPath(refPath) },
  }
}

/** Write every decoded image to a NON-overwriting versioned jailed path.
 *  Returns the written paths (+ first image for the inline preview) or a typed
 *  failure on the first error (oversize / jail escape / no free sibling). */
const writeImages = async (
  images: readonly GeneratedImage[],
  outputPath: string,
  cwd: string,
  writePort: ImageWritePort,
): Promise<
  | { kind: "ok"; paths: string[]; first?: { bytes: Uint8Array; mediaType: string } }
  | {
      kind: "fail"
      result: ToolResult
    }
> => {
  const total = images.length
  const paths: string[] = []
  let first: { bytes: Uint8Array; mediaType: string } | undefined
  for (let i = 0; i < total; i++) {
    const img = images[i] as GeneratedImage
    const decoded = decodeImage(img)
    if (decoded.kind === "fail") return decoded
    const requested = indexedPath(outputPath, i, total)
    let target: string | null
    try {
      target = await resolveVersionedTarget(requested, cwd, writePort)
    } catch (e) {
      if (e instanceof FsJailError) {
        return {
          kind: "fail",
          result: errResult(e.message, {
            mode: "permission_denied",
            path: requested,
            isReadonly: false,
          }),
        }
      }
      return { kind: "fail", result: errResult(`path resolve failed: ${errMessage(e)}`) }
    }
    if (target === null) {
      return {
        kind: "fail",
        result: errResult(
          `no free versioned sibling for ${requested} (probed ${VERSION_PROBE_CAP})`,
        ),
      }
    }
    try {
      await writePort.writeBytes(target, decoded.bytes)
    } catch (e) {
      return {
        kind: "fail",
        result: errResult(`write failed: ${errMessage(e)}`, {
          mode: "error",
          modelVisibleError: "write_failed",
        }),
      }
    }
    paths.push(target)
    if (i === 0) first = { bytes: decoded.bytes, mediaType: img.mediaType }
  }
  return first !== undefined ? { kind: "ok", paths, first } : { kind: "ok", paths }
}

/** Map a non-ok provider outcome to a typed ToolResult. */
const outcomeFailure = (
  outcome: { kind: "no_key" } | { kind: "error"; message: string },
): ToolResult =>
  outcome.kind === "no_key"
    ? errResult(
        "no image provider key wired; set OPENAI_API_KEY (the host resolves it from runtime-config)",
        { mode: "error", modelVisibleError: "no_provider_key" },
      )
    : errResult(outcome.message, { mode: "error", modelVisibleError: outcome.message })

/** Resolve the (optional) edit reference into the request's reference list, or
 *  return a typed failure. `null` references ⇒ generate-mode (empty list). */
const collectReferences = async (
  data: ImageGenInput,
  cwd: string,
): Promise<{ kind: "ok"; refs: GeneratedImage[] } | { kind: "fail"; result: ToolResult }> => {
  if ((data.mode ?? "generate") !== "edit" || data.referenceImagePath === undefined) {
    return { kind: "ok", refs: [] }
  }
  const ref = await loadReference(data.referenceImagePath, cwd)
  if (ref.kind === "fail") return ref
  return { kind: "ok", refs: [ref.image] }
}

/** Call the provider, catching a throwing port at the boundary. */
const callProvider = async (
  port: ImageGenPort,
  req: ImageGenRequest,
  signal: AbortSignal,
): Promise<
  { kind: "ok"; images: readonly GeneratedImage[] } | { kind: "fail"; result: ToolResult }
> => {
  let outcome: Awaited<ReturnType<ImageGenPort["generate"]>>
  try {
    outcome = await port.generate(req, signal)
  } catch (e) {
    const msg = errMessage(e)
    return {
      kind: "fail",
      result: errResult(`provider threw: ${msg}`, { mode: "error", modelVisibleError: msg }),
    }
  }
  if (outcome.kind !== "ok") return { kind: "fail", result: outcomeFailure(outcome) }
  return { kind: "ok", images: outcome.images }
}

/** Build the success ToolResult (summary + optional inline preview). */
const successResult = (
  paths: readonly string[],
  inlinePreview: boolean,
  first: { bytes: Uint8Array; mediaType: string } | undefined,
): ToolResult => {
  const summary =
    paths.length === 1
      ? `Wrote image to ${paths[0]}`
      : `Wrote ${paths.length} images:\n${paths.map((p) => `  ${p}`).join("\n")}`
  if (!inlinePreview || first === undefined) return { ok: true, output: summary }
  const image: ImageBlock = {
    type: "image",
    data: Buffer.from(first.bytes).toString("base64"),
    mediaType: first.mediaType,
  }
  return { ok: true, output: summary, images: [image] }
}

/** Whole image-gen flow as ONE typed ToolResult (no generator branching). */
const runImageGen = async (
  input: ImageGenInput,
  ctx: ToolContext,
  port: ImageGenPort,
  writePort: ImageWritePort,
): Promise<ToolResult> => {
  const parsed = imageGenInputSchema.safeParse(input)
  if (!parsed.success) return errResult(`invalid input: ${parsed.error.message}`)
  if (ctx.signal.aborted) return errResult("aborted before start")
  const data = parsed.data
  if ((data.mode ?? "generate") === "edit" && data.referenceImagePath === undefined) {
    return errResult("mode:edit requires referenceImagePath", {
      mode: "rejected",
      reason: "missing_reference",
    })
  }

  const refs = await collectReferences(data, ctx.cwd)
  if (refs.kind === "fail") return refs.result

  const req = buildRequest(data, formatFromPath(data.outputPath), refs.refs)
  const provided = await callProvider(port, req, ctx.signal)
  if (provided.kind === "fail") return provided.result

  const written = await writeImages(provided.images, data.outputPath, ctx.cwd, writePort)
  if (written.kind === "fail") return written.result
  return successResult(written.paths, data.inlinePreview === true, written.first)
}

/** Build the `image_gen` tool against an injected provider + write port. */
export const imageGenTool = (options: ImageGenToolOptions = {}): Tool<ImageGenInput> => {
  const port = options.port ?? openAiImagePort()
  const writePort = options.writePort ?? defaultImageWritePort

  return defineTool<ImageGenInput>({
    name: "image_gen",
    description:
      "Generate (text→image) or edit a raster image via the wired provider and write it to a " +
      "jailed file path. WRITES files (mutating). Never overwrites an existing file — writes a " +
      "versioned sibling (`hero.png` → `hero-v2.png`). Use `mode:edit` with `referenceImagePath` " +
      "to transform an existing image. Set `inlinePreview:true` to also surface the result to the " +
      "model. For many DISTINCT assets, issue one call per asset; `n` is variants of ONE prompt.",
    inputSchema: imageGenInputSchema,
    isReadOnly: () => false,
    // Mutates the filesystem (and spends provider quota); never run concurrently.
    isConcurrencySafe: () => false,
    // Writing a generated artifact to a jailed workspace path is a contained,
    // VCS-reversible mutation — pre-approval covers it (mirrors `write`). Must
    // be explicit: the mutating-tool fallback tier is `always-confirm`.
    hitlTier: (): "pre-approval-ok" => "pre-approval-ok",

    async *execute(input: ImageGenInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
      yield { type: "result", result: await runImageGen(input, ctx, port, writePort) }
    },
  })
}
