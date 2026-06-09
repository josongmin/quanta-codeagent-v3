/**
 * `read_image` tool (ADR-0126) — vision-input slice.
 *
 * Reads an image file from disk, magic-byte-sniffs the media type, and surfaces
 * it via `ToolResult.images` so the dispatch seam can compose a structured
 * tool_result content array (text + image) the model can actually see.
 *
 * Slice posture:
 *   - Imports ONLY: `zod`, `node:fs/promises`, `node:path`, `@/llm` (for the
 *     `ImageBlock` type), `../types`. NO `@/agent`, `@/permission`,
 *     `@/storage` (path safety is local — leaf-symlink + size cap + magic-byte).
 *   - No-throw: every failure mode yields a typed `ok:false` `ToolResult`.
 *   - exactOptionalPropertyTypes-clean: `images` is added on the OK result
 *     only; ok:false results never carry the field (the helper composer treats
 *     absent === empty).
 *
 * Security:
 *   - Leaf-symlink reject (`lstat().isSymbolicLink()`) — prevents the model
 *     from indirecting through a symlink into a forbidden path.
 *   - 5 MB cap (Anthropic Messages vision raw-byte ceiling).
 *   - MIME from magic bytes, NOT extension — a `.png` that's actually JPEG is
 *     classified by content, and a spoofed extension over non-image bytes is
 *     rejected as "unsupported or unrecognized media type".
 */

import { lstat } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import type { ImageBlock } from "@/llm"
import { errMessage } from "@/shared"
import { FsJailError } from "@/storage"
import { resolveJailedDoc } from "../_shared/resolve-jailed-doc"
import type { Tool, ToolContext, ToolEvent, ToolResult } from "../types"
import { planImageRead } from "./downsample-plan"
import type { ImageDownsamplePort } from "./downsample-port"
export const readImageInputSchema = z.object({
  path: z.string().min(1).describe("Repo-relative or absolute path to the image file"),
})
export type ReadImageInput = z.infer<typeof readImageInputSchema>

/** Supported media types — Anthropic Messages API vision support. Hardcoded
 *  list (NOT extension-only) so a misnamed file (.png that's actually JPEG)
 *  is detected by magic bytes, not by trusting the path. */
export const SUPPORTED_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const
export type SupportedMediaType = (typeof SUPPORTED_MEDIA_TYPES)[number]

/** Anthropic vision cap — 5 MB raw bytes (before base64). We reject above this
 *  at the tool boundary; future re-encoding/downsizing belongs in a follow-up. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

/** gap-other-agent GAP 1 — longest-edge target the downsample port shrinks an
 *  oversized image to (a sensible vision-input dimension). The codec computes the
 *  paired short edge via {@link scaleToMaxDim}. */
export const DOWNSAMPLE_MAX_DIM = 2048

/** Magic-byte sniff. Returns null when the bytes don't match any supported
 *  type; the tool emits ok:false in that case (the only typed-content
 *  invariant — extension is for hints, magic bytes are the SSOT).
 *
 *  Signatures:
 *    PNG  : 89 50 4E 47 0D 0A 1A 0A
 *    JPEG : FF D8 FF
 *    GIF  : 47 49 46 38 (then 37 or 39) 61 — "GIF87a" / "GIF89a"
 *    WEBP : 52 49 46 46 .. .. .. .. 57 45 42 50 — "RIFF" + 4 byte length + "WEBP"
 */
export const sniffMediaType = (bytes: Uint8Array): SupportedMediaType | null => {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png"
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg"
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "image/gif"
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp"
  }
  return null
}

/** Build the ok:false result for a `not_found`/lstat-failure. We surface the
 *  raw error code/message in `output` (the model treats it as a typed signal)
 *  AND attach a typed `failure` so a future router can branch without regex. */
const errResult = (output: string, failure?: ToolResult["failure"]): ToolResult =>
  failure === undefined ? { ok: false, output } : { ok: false, output, failure }

/** lstat phase — return either an early ToolResult (failure) or the stat
 *  handle. Extracted so the top-level `execute` stays under the cognitive
 *  complexity gate. */
const statPhase = async (
  abs: string,
  visiblePath: string,
  canDownsample: boolean,
): Promise<
  { kind: "fail"; result: ToolResult } | { kind: "ok"; stat: Awaited<ReturnType<typeof lstat>> }
> => {
  try {
    const stat = await lstat(abs)
    if (stat.isSymbolicLink()) {
      return {
        kind: "fail",
        result: errResult(`symlink not allowed: ${visiblePath}`, {
          mode: "permission_denied",
          path: visiblePath,
          isReadonly: true,
        }),
      }
    }
    if (!stat.isFile()) {
      return {
        kind: "fail",
        result: errResult(`not a regular file: ${visiblePath}`, {
          mode: "not_found",
          path: visiblePath,
        }),
      }
    }
    if (stat.size > MAX_IMAGE_BYTES && !canDownsample) {
      // gap-other-agent GAP 1: when a downsample codec is wired, DEFER the
      // over-cap decision to decodePhase (which has the bytes + port). Absent a
      // port (canDownsample=false) ⇒ reject here exactly as before (byte-identical).
      return {
        kind: "fail",
        result: errResult(`image too large: ${stat.size} bytes (cap ${MAX_IMAGE_BYTES})`, {
          mode: "error",
          modelVisibleError: "image_over_cap",
        }),
      }
    }
    return { kind: "ok", stat }
  } catch (e) {
    const msg = errMessage(e)
    const isEnoent =
      typeof e === "object" && e !== null && (e as { code?: unknown }).code === "ENOENT"
    return {
      kind: "fail",
      result: errResult(
        isEnoent ? `File not found: ${visiblePath}` : `lstat failed: ${msg}`,
        isEnoent
          ? { mode: "not_found", path: visiblePath }
          : { mode: "error", modelVisibleError: msg },
      ),
    }
  }
}

/** Bytes-read + sniff phase. Returns either an early ToolResult or the typed
 *  payload the OK branch needs to compose the final result. */
const decodePhase = async (
  abs: string,
  visiblePath: string,
  downsamplePort: ImageDownsamplePort | undefined,
  signal: AbortSignal,
): Promise<
  | { kind: "fail"; result: ToolResult }
  | { kind: "ok"; bytes: Uint8Array; mediaType: SupportedMediaType }
> => {
  let bytes: Uint8Array
  try {
    bytes = await Bun.file(abs).bytes()
  } catch (e) {
    const msg = errMessage(e)
    return {
      kind: "fail",
      result: errResult(`read failed: ${msg}`, { mode: "error", modelVisibleError: msg }),
    }
  }
  const mediaType = sniffMediaType(bytes)
  if (mediaType === null) {
    return {
      kind: "fail",
      result: errResult(`unsupported or unrecognized media type: ${visiblePath}`, {
        mode: "error",
        modelVisibleError: "unsupported_media_type",
      }),
    }
  }
  // gap-other-agent GAP 1 — decide on the ACTUAL bytes: within cap ⇒ use as-is;
  // over cap + codec wired ⇒ downsample; over cap + no codec ⇒ reject (today's
  // behavior, byte-identical when unwired).
  const plan = planImageRead(bytes.length, MAX_IMAGE_BYTES, downsamplePort !== undefined)
  if (plan === "reject") {
    return {
      kind: "fail",
      result: errResult(`image too large: ${bytes.length} bytes (cap ${MAX_IMAGE_BYTES})`, {
        mode: "error",
        modelVisibleError: "image_over_cap",
      }),
    }
  }
  if (plan === "downsample" && downsamplePort !== undefined) {
    const out = await downsamplePort.downsample(
      bytes,
      mediaType,
      MAX_IMAGE_BYTES,
      DOWNSAMPLE_MAX_DIM,
      signal,
    )
    if (out.kind === "ok") {
      // Re-enforce the BYTE cap on the codec output. `downsample` caps the
      // longest EDGE (sips `-Z`), NOT the byte size — a dense/noisy image can
      // fit the edge bound yet still exceed MAX_IMAGE_BYTES, and forwarding it
      // would defeat the very cap the downsample exists to honor.
      if (out.bytes.length <= MAX_IMAGE_BYTES)
        return { kind: "ok", bytes: out.bytes, mediaType: out.mediaType }
      return {
        kind: "fail",
        result: errResult(
          `image too large: ${bytes.length} bytes (cap ${MAX_IMAGE_BYTES}); downsample still over cap: ${out.bytes.length} bytes`,
          { mode: "error", modelVisibleError: "image_over_cap" },
        ),
      }
    }
    return {
      kind: "fail",
      result: errResult(
        `image too large: ${bytes.length} bytes (cap ${MAX_IMAGE_BYTES}); downsample unable: ${out.reason}`,
        { mode: "error", modelVisibleError: "image_over_cap" },
      ),
    }
  }
  return { kind: "ok", bytes, mediaType }
}

/** Pre-flight (schema parse + abort + path resolve via unified FS jail).
 *  Path safety is delegated to {@link resolveJailedDoc} (Slice S7) — the
 *  canonical `@/storage/service`-backed chokepoint. The catch-and-translate
 *  here preserves the historical "path outside cwd: …" message + typed
 *  `permission_denied` failure so existing hellgate tests stay green. */
const preflight = (
  input: ReadImageInput,
  ctx: ToolContext,
): { kind: "fail"; result: ToolResult } | { kind: "ok"; abs: string; visiblePath: string } => {
  const parsed = readImageInputSchema.safeParse(input)
  if (!parsed.success) {
    return { kind: "fail", result: errResult(`invalid input: ${parsed.error.message}`) }
  }
  if (ctx.signal.aborted) {
    return { kind: "fail", result: errResult("aborted before start") }
  }
  let abs: string
  try {
    abs = resolveJailedDoc(ctx.cwd, parsed.data.path, "image")
  } catch (e) {
    if (e instanceof FsJailError) {
      return {
        kind: "fail",
        result: errResult(`path outside cwd: ${parsed.data.path}`, {
          mode: "permission_denied",
          path: parsed.data.path,
          isReadonly: true,
        }),
      }
    }
    throw e
  }
  return { kind: "ok", abs, visiblePath: parsed.data.path }
}

/** Build the `read_image` tool. `downsamplePort` (gap-other-agent GAP 1) is
 *  default-OFF: absent ⇒ oversized images are rejected exactly as before
 *  (byte-identical); present ⇒ over-cap images are downsampled via the codec. */
export const makeReadImageTool = (downsamplePort?: ImageDownsamplePort): Tool<ReadImageInput> => ({
  name: "read_image",
  description:
    "Read an image file and attach it to the model's view via the next tool_result. " +
    "Supports PNG, JPEG, WebP, GIF; up to 5 MB.",
  inputSchema: readImageInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async *execute(input: ReadImageInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const pre = preflight(input, ctx)
    if (pre.kind === "fail") {
      yield { type: "result", result: pre.result }
      return
    }
    const statOut = await statPhase(pre.abs, pre.visiblePath, downsamplePort !== undefined)
    if (statOut.kind === "fail") {
      yield { type: "result", result: statOut.result }
      return
    }
    const decoded = await decodePhase(pre.abs, pre.visiblePath, downsamplePort, ctx.signal)
    if (decoded.kind === "fail") {
      yield { type: "result", result: decoded.result }
      return
    }
    const data = Buffer.from(decoded.bytes).toString("base64")
    const image: ImageBlock = { type: "image", data, mediaType: decoded.mediaType }
    yield {
      type: "result",
      result: {
        ok: true,
        output: `Read image: ${path.basename(pre.abs)} (${decoded.mediaType}, ${decoded.bytes.length} bytes)`,
        images: [image],
      },
    }
  },
})

/** Default `read_image` tool — NO downsample codec (oversized ⇒ reject, exactly
 *  as before this slice). The composition root passes a port via
 *  {@link makeReadImageTool} / `DefaultToolPorts.imageDownsample` when wired. */
export const readImageTool: Tool<ReadImageInput> = makeReadImageTool()
