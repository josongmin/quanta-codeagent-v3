/**
 * `read_image_url` tool (ADR-0132) — URL → vision pipeline.
 *
 * Composes ADR-0126 (read_image: magic-byte sniffer + 5 MB cap) and ADR-0127
 * (web_fetch: SSRF denylist + https-only) into a tool that fetches an HTTPS
 * image URL and surfaces it via `ToolResult.images` for the dispatch seam to
 * compose a tool_result the model can actually see.
 *
 * Slice posture:
 *   - Imports ONLY: `zod`, `./read` (sniffer + cap SSOT), `../types`.
 *     Does NOT import `../web/fetch` (sibling tool slice is concurrently
 *     touched + the SSRF predicate is not exported). The denylist is
 *     duplicated below — DRY-violation EXPLICITLY documented in the ADR as
 *     "intentional; future helper consolidation deferred to a separate ADR
 *     that exposes `isPrivateOrLoopbackHostname` from a shared layer".
 *   - No-throw: every failure mode (schema, abort, non-https, SSRF, fetch
 *     error, non-2xx, oversize body, bad magic) yields a typed `ok:false`
 *     {@link ToolResult}.
 *   - DI seam: `readImageUrlTool({ fetcher })` lets a test inject a fake
 *     `fetch`. Production callers `readImageUrlTool()` get global `fetch`.
 *
 * Security:
 *   - TLS-required: non-`https:` rejected at URL-parse boundary.
 *   - SSRF denylist (same literal-host prefix set web_fetch uses).
 *   - 5 MB cap (Anthropic vision raw-byte ceiling; matches `read_image`).
 *   - Magic-byte SSOT — extension is a hint only; the bytes decide.
 */

import { z } from "zod"
import type { ImageBlock } from "@/llm"
import { errMessage } from "@/shared"
import { fetchWithSsrfGuard, SsrfGuardError, ssrfDeny } from "@/shared/net/ssrf"
import type { Tool, ToolContext, ToolEvent, ToolResult } from "../types"
import { MAX_IMAGE_BYTES, type SupportedMediaType, sniffMediaType } from "./read"
export const readImageUrlInputSchema = z.object({
  url: z.string().url().describe("HTTPS image URL"),
})
export type ReadImageUrlInput = z.infer<typeof readImageUrlInputSchema>

export interface ReadImageUrlOpts {
  /** Injected fetcher (test seam). Default = `globalThis.fetch`. */
  readonly fetcher?: typeof fetch
}

/**
 * SSRF defense now delegates to the canonical structural classifier
 * `@/shared/net/ssrf#ssrfDeny` (imported above) — the previously-duplicated
 * prefix-string denylist is gone (it missed IPv4-mapped IPv6 / decimal / hex
 * forms). The same predicate is re-run on every redirect hop via
 * `fetchWithSsrfGuard`, closing the redirect bypass where a public image URL
 * 30x-redirects to an internal address.
 */

/** Build an ok:false ToolResult with an optional typed failure. */
const errResult = (output: string, failure?: ToolResult["failure"]): ToolResult =>
  failure === undefined ? { ok: false, output } : { ok: false, output, failure }

/** Pre-flight (schema + abort + URL parse + protocol + SSRF). */
const preflight = (
  input: ReadImageUrlInput,
  ctx: ToolContext,
): { kind: "fail"; result: ToolResult } | { kind: "ok"; url: URL } => {
  const parsed = readImageUrlInputSchema.safeParse(input)
  if (!parsed.success) {
    return { kind: "fail", result: errResult(`invalid input: ${parsed.error.message}`) }
  }
  if (ctx.signal.aborted) {
    return { kind: "fail", result: errResult("aborted before start") }
  }
  let url: URL
  try {
    url = new URL(parsed.data.url)
  } catch (e) {
    const msg = errMessage(e)
    return { kind: "fail", result: errResult(`invalid URL: ${msg}`) }
  }
  if (url.protocol !== "https:") {
    return { kind: "fail", result: errResult(`only https:// allowed (got ${url.protocol})`) }
  }
  const deny = ssrfDeny(url.hostname)
  if (deny !== null) {
    return {
      kind: "fail",
      result: errResult(`SSRF denied: ${url.hostname} — ${deny}`, {
        mode: "permission_denied",
        path: url.hostname,
        isReadonly: true,
      }),
    }
  }
  return { kind: "ok", url }
}

/** Network fetch — never throws past this boundary. Uses `fetchWithSsrfGuard`
 *  (redirect:"manual" + per-hop https + SSRF host re-check) so a 30x redirect
 *  to an internal address is rejected rather than silently followed. */
const fetchPhase = async (
  fetcher: typeof fetch,
  url: string,
  signal: AbortSignal,
): Promise<{ kind: "fail"; result: ToolResult } | { kind: "ok"; res: Response }> => {
  try {
    const res = await fetchWithSsrfGuard(fetcher, url, { signal })
    return { kind: "ok", res }
  } catch (e) {
    if (e instanceof SsrfGuardError) {
      return {
        kind: "fail",
        result: errResult(e.message, {
          mode: "permission_denied",
          path: e.hostname,
          isReadonly: true,
        }),
      }
    }
    const msg = errMessage(e)
    return {
      kind: "fail",
      result: errResult(`fetch failed: ${msg}`, { mode: "error", modelVisibleError: msg }),
    }
  }
}

/** Read response body to a single Uint8Array. Uses `arrayBuffer()` because the
 *  total-cap enforcement happens AFTER the read on the typed length — we still
 *  bound it via the same 5 MB ceiling. A streaming early-abort variant is a
 *  future enhancement (matches web_fetch's `readCappedBody` posture). */
const readBytes = async (
  res: Response,
): Promise<{ kind: "fail"; result: ToolResult } | { kind: "ok"; bytes: Uint8Array }> => {
  try {
    const ab = await res.arrayBuffer()
    return { kind: "ok", bytes: new Uint8Array(ab) }
  } catch (e) {
    const msg = errMessage(e)
    return {
      kind: "fail",
      result: errResult(`body read failed: ${msg}`, { mode: "error", modelVisibleError: msg }),
    }
  }
}

/** Inspect Response — non-2xx → typed ok:false. */
const inspectResponse = (res: Response): { kind: "fail"; result: ToolResult } | { kind: "ok" } => {
  if (!res.ok) {
    return {
      kind: "fail",
      result: errResult(`HTTP ${res.status} ${res.statusText}`, {
        mode: "error",
        modelVisibleError: `http_${res.status}`,
      }),
    }
  }
  return { kind: "ok" }
}

/** Cap + magic-byte sniff phase. */
const decodePhase = (
  bytes: Uint8Array,
): { kind: "fail"; result: ToolResult } | { kind: "ok"; mediaType: SupportedMediaType } => {
  if (bytes.length > MAX_IMAGE_BYTES) {
    return {
      kind: "fail",
      result: errResult(`image too large: ${bytes.length} bytes (cap ${MAX_IMAGE_BYTES})`, {
        mode: "error",
        modelVisibleError: "image_over_cap",
      }),
    }
  }
  const mediaType = sniffMediaType(bytes)
  if (mediaType === null) {
    return {
      kind: "fail",
      result: errResult(`unsupported or unrecognized media type`, {
        mode: "error",
        modelVisibleError: "unsupported_media_type",
      }),
    }
  }
  return { kind: "ok", mediaType }
}

/** Factory — `readImageUrlTool()` binds global `fetch`; `readImageUrlTool({
 *  fetcher: fake })` swaps in a test double. */
export const readImageUrlTool = (options: ReadImageUrlOpts = {}): Tool<ReadImageUrlInput> => {
  const fetcher = options.fetcher ?? globalThis.fetch

  return {
    name: "read_image_url",
    description:
      "Fetch an HTTPS image URL and attach it to the model's view via tool_result. " +
      "Same media-type policy as read_image (magic-byte SSOT, 5 MB cap, " +
      "png/jpeg/webp/gif). SSRF-defended (rejects http://, file://, and " +
      "private/loopback addresses).",
    inputSchema: readImageUrlInputSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,

    async *execute(input: ReadImageUrlInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const pre = preflight(input, ctx)
      if (pre.kind === "fail") {
        yield { type: "result", result: pre.result }
        return
      }
      const fetched = await fetchPhase(fetcher, pre.url.toString(), ctx.signal)
      if (fetched.kind === "fail") {
        yield { type: "result", result: fetched.result }
        return
      }
      const inspected = inspectResponse(fetched.res)
      if (inspected.kind === "fail") {
        yield { type: "result", result: inspected.result }
        return
      }
      const read = await readBytes(fetched.res)
      if (read.kind === "fail") {
        yield { type: "result", result: read.result }
        return
      }
      const decoded = decodePhase(read.bytes)
      if (decoded.kind === "fail") {
        yield { type: "result", result: decoded.result }
        return
      }
      const data = Buffer.from(read.bytes).toString("base64")
      const image: ImageBlock = { type: "image", data, mediaType: decoded.mediaType }
      yield {
        type: "result",
        result: {
          ok: true,
          output: `Fetched image: ${pre.url.toString()} (${decoded.mediaType}, ${read.bytes.length} bytes)`,
          images: [image],
        },
      }
    },
  }
}
