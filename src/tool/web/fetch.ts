/**
 * `web_fetch` tool (ADR-0127, Part 1) — fetch an HTTPS URL and return the
 * page text (HTML→Markdown). Read-only, always-on, no provider required.
 *
 * Slice posture (RFC §3.1):
 *   - Imports ONLY: `zod`, `../types`. NO `@/agent`, `@/permission`,
 *     `@/storage`, `@/memory`, `@/stream`, `@/lsp`, `@/observability`.
 *   - No-throw: every failure mode (schema, abort, SSRF deny, network error,
 *     non-2xx, oversize body, binary content-type) yields a typed `ok:false`
 *     {@link ToolResult}.
 *   - exactOptionalPropertyTypes-clean: optional fields on input are spelled
 *     `| undefined` so `z.optional()`'s `T | undefined` output is assignable
 *     without widening.
 *   - DI seam: `webFetchTool({ fetcher })` lets a test or surface inject a
 *     fake `fetch` without touching the network. Production callers
 *     `webFetchTool()` get the global `fetch` (Bun / Node 18+).
 *
 * Security:
 *   - TLS-required: non-`https:` protocols (`http:`, `file:`, `data:`, etc.)
 *     are rejected at the URL-parse boundary. Same posture as Anthropic's
 *     Claude Code `WebFetch` tool.
 *   - SSRF denylist (literal-host match, NO DNS resolution): the 9 ranges
 *     below cover loopback, RFC1918 private networks, link-local, and IPv6
 *     loopback / ULA. A future ADR may extend with DNS-resolution-aware
 *     verification; today's posture matches `WebFetch`'s static deny.
 *   - Response size cap: streaming chunk loop aborts as soon as accumulated
 *     bytes exceed `maxBytes` (default 1 MB; cap 5 MB). Prevents OOM on a
 *     200-class response that ships gigabytes.
 *   - Binary-content reject: `image/*`, `application/octet-stream`,
 *     `application/pdf` (and other non-text content-types) yield ok:false
 *     with the hint to use a dedicated tool.
 *
 * The HTML→Markdown converter lives in a sibling module
 * (`./html-to-markdown`) backed by the `turndown` library (ADR-0186).
 * Re-exported here as `htmlToMarkdown` so external callers and the legacy
 * hellgate import path stay byte-stable.
 */

import { z } from "zod"
import { errMessage } from "@/shared"
import { fetchWithSsrfGuard, type HostResolver, SsrfGuardError, ssrfDeny } from "@/shared/net/ssrf"
import type { CoreToolContext, Tool, ToolEvent, ToolResult } from "../types"
import { htmlToMarkdown } from "./html-to-markdown"

// Re-export so the legacy import path (`./fetch` → `htmlToMarkdown`)
// continues to resolve. The barrel `./index.ts` re-exports from
// `./html-to-markdown` directly; this keeps `./fetch` itself stable for
// any callers that bypass the barrel.
export { htmlToMarkdown }

/** Default cap on the fetched body size (bytes). The model rarely needs
 *  more than ~50 KB of an HTML page, but we let small docs (RFCs, large
 *  README pages) come through up to 1 MB. */
export const WEB_FETCH_DEFAULT_MAX_BYTES = 1_000_000

/** Hard ceiling — the user may raise `maxBytes` up to this value, beyond
 *  which the input is rejected. Pegs at 5 MB to match the `read_image` cap
 *  posture (ADR-0126) — a single response should never dominate the model's
 *  context window. */
export const WEB_FETCH_MAX_BYTES_CEILING = 5_000_000

/** Cap on the FINAL `output` string returned to the model. Independent of
 *  `maxBytes` which caps the RAW response body — the markdown conversion
 *  itself can expand or shrink the byte count. */
export const WEB_FETCH_MAX_OUTPUT = 50_000

export const webFetchInputSchema = z.object({
  url: z
    .string()
    .url()
    .refine((u) => u.startsWith("https://"), {
      message: "only https:// allowed",
    })
    .describe("HTTPS URL to fetch"),
  maxBytes: z
    .number()
    .int()
    .positive()
    .max(WEB_FETCH_MAX_BYTES_CEILING)
    .optional()
    .describe(`Response size cap in bytes (default ${WEB_FETCH_DEFAULT_MAX_BYTES})`),
})
export type WebFetchInput = z.infer<typeof webFetchInputSchema>

/** SSRF defense lives in the canonical structural classifier
 *  `@/shared/net/ssrf#ssrfDeny` (imported above), which parses IP literals and
 *  normalizes IPv4-mapped IPv6 / decimal / hex forms the old prefix-string
 *  match missed. The same predicate is re-run on every redirect hop by
 *  `fetchWithSsrfGuard`, so a 30x to an internal address can no longer slip
 *  past the pre-flight host check. */

/** Build the ok:false result. Carries a typed `failure` when supplied so a
 *  future router can branch without regex on `output`. */
const errResult = (output: string, failure?: ToolResult["failure"]): ToolResult =>
  failure === undefined ? { ok: false, output } : { ok: false, output, failure }

/** Inject a fake `fetch` for testing without touching the network. The
 *  production tool exports `webFetchTool()` which binds `globalThis.fetch`. */
export interface WebFetchOptions {
  fetcher?: typeof fetch
  /** Test seam for the SSRF DNS-rebinding check. Default = platform DNS. */
  resolveHost?: HostResolver
}

/** Pre-flight (schema + abort + URL parse + protocol + SSRF). Returns an
 *  early `ToolResult` on any rejection, else the parsed URL + cap. */
const preflight = (
  input: WebFetchInput,
  ctx: CoreToolContext,
): { kind: "fail"; result: ToolResult } | { kind: "ok"; url: URL; maxBytes: number } => {
  const parsed = webFetchInputSchema.safeParse(input)
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
  const maxBytes = parsed.data.maxBytes ?? WEB_FETCH_DEFAULT_MAX_BYTES
  return { kind: "ok", url, maxBytes }
}

/** Binary content-types we reject outright (the model can't use base64 from
 *  this tool — `read_image` is the vision surface). Match against
 *  `Content-Type` prefix. */
const BINARY_CONTENT_PREFIXES = [
  "image/",
  "audio/",
  "video/",
  "application/octet-stream",
  "application/pdf",
  "application/zip",
  "application/gzip",
  "application/x-tar",
] as const

const isBinaryContentType = (ct: string): boolean => {
  const lower = ct.toLowerCase()
  for (const p of BINARY_CONTENT_PREFIXES) {
    if (lower.startsWith(p)) return true
  }
  return false
}

/** Stream the response body with a hard byte cap. Returns the accumulated
 *  bytes (truncated at `maxBytes`) and a `truncated` flag for the caller to
 *  surface in `output`, or `kind:"aborted"` when `signal` fires mid-read.
 *  Abort is a failure, not a successful truncated response. We use the
 *  response's reader so we don't buffer the whole body just to chop the tail. */
const readCappedBody = async (
  res: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ kind: "ok"; bytes: Uint8Array; truncated: boolean } | { kind: "aborted" }> => {
  const reader = res.body?.getReader()
  if (reader === undefined) {
    // Body-less response (HEAD-like) — return empty.
    return { kind: "ok", bytes: new Uint8Array(0), truncated: false }
  }
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false
  let aborted = signal.aborted
  const onAbort = (): void => {
    aborted = true
    void reader.cancel().catch(() => {
      // best-effort
    })
  }
  if (!aborted) signal.addEventListener("abort", onAbort, { once: true })
  try {
    if (aborted) return { kind: "aborted" }
    while (true) {
      if (aborted) return { kind: "aborted" }
      try {
        const step = await reader.read()
        if (aborted || signal.aborted) return { kind: "aborted" }
        const { done, value } = step
        if (done) break
        if (value === undefined) continue
        const remaining = maxBytes - total
        if (value.byteLength > remaining) {
          chunks.push(value.subarray(0, remaining))
          total += remaining
          truncated = true
          break
        }
        chunks.push(value)
        total += value.byteLength
      } catch (e) {
        if (aborted || signal.aborted) return { kind: "aborted" }
        throw e
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort)
    try {
      await reader.cancel()
    } catch {
      // best-effort
    }
  }
  // Concatenate chunks into a single Uint8Array.
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return { kind: "ok", bytes: out, truncated }
}

/** Truncate output to `WEB_FETCH_MAX_OUTPUT`, with a suffix the model can
 *  read to decide whether to refine the fetch. */
const truncateOutput = (s: string): string => {
  if (s.length <= WEB_FETCH_MAX_OUTPUT) return s
  const more = s.length - WEB_FETCH_MAX_OUTPUT
  return `${s.slice(0, WEB_FETCH_MAX_OUTPUT)}\n\n(truncated, ${more} more chars)`
}

/** Compose the final OK output text. */
const composeOkOutput = (args: {
  url: string
  status: number
  contentType: string
  bytesLen: number
  body: string
  truncatedBody: boolean
}): string => {
  const header =
    `URL: ${args.url}\n` +
    `Status: ${args.status}\n` +
    `Content-Type: ${args.contentType}\n` +
    `Length: ${args.bytesLen} bytes${args.truncatedBody ? " (body truncated to cap)" : ""}\n\n`
  return truncateOutput(header + args.body)
}

/** TextDecoder constructor surface bridged through `unknown` (Node's
 *  `@types/node` narrows the label arg to a small `Encoding` enum; the
 *  WHATWG TextDecoder accepts a much wider label set at runtime). An
 *  unknown label throws RangeError which the caller's catch handles by
 *  falling back to utf-8. */
type TextDecoderCtor = new (
  label?: string,
  options?: { fatal?: boolean; ignoreBOM?: boolean },
) => { decode(bytes: Uint8Array): string }
const WideTextDecoder = TextDecoder as unknown as TextDecoderCtor

/** Convert raw bytes to text using the response's declared charset (UTF-8
 *  fallback). `TextDecoder` is a Web API present in Bun / Node 18+. */
const bytesToText = (bytes: Uint8Array, contentType: string): string => {
  // Pull `charset=...` if present, else UTF-8.
  const m = /charset=([^;]+)/i.exec(contentType)
  const charset = m?.[1]?.trim().replace(/['"]/g, "").toLowerCase() ?? "utf-8"
  try {
    return new WideTextDecoder(charset, { fatal: false }).decode(bytes)
  } catch {
    return new WideTextDecoder("utf-8", { fatal: false }).decode(bytes)
  }
}

/** Network fetch phase — returns either an early ToolResult or the Response.
 *  Wraps the fetch call so a network throw never escapes to `execute`.
 *  Uses `fetchWithSsrfGuard` (redirect:"manual" + per-hop https + SSRF host
 *  re-check) so a public URL that 30x-redirects to an internal address is
 *  rejected as an SSRF deny rather than silently followed. */
const fetchPhase = async (
  fetcher: typeof fetch,
  url: string,
  signal: AbortSignal,
  resolveHost?: HostResolver,
): Promise<{ kind: "fail"; result: ToolResult } | { kind: "ok"; res: Response }> => {
  try {
    const res = await fetchWithSsrfGuard(
      fetcher,
      url,
      { signal },
      resolveHost !== undefined ? { resolveHost } : {},
    )
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
      result: errResult(`fetch failed: ${msg}`, {
        mode: "error",
        modelVisibleError: msg,
      }),
    }
  }
}

/** Build the ok:false ToolResult for a non-2xx response, including a
 *  best-effort first-line snippet of the body. Body-read errors never
 *  propagate. */
const nonOkResult = async (res: Response): Promise<ToolResult> => {
  let snippet = ""
  try {
    const text = await res.text()
    snippet = text.split("\n")[0]?.slice(0, 200) ?? ""
  } catch {
    // best-effort
  }
  return errResult(`HTTP ${res.status} ${res.statusText}${snippet ? ` — ${snippet}` : ""}`, {
    mode: "error",
    modelVisibleError: `http_${res.status}`,
  })
}

/** Body decode + (HTML→Markdown if applicable) phase. Catches reader errors
 *  and yields a typed ok:false. */
const decodeBodyPhase = async (
  res: Response,
  maxBytes: number,
  signal: AbortSignal,
  contentType: string,
): Promise<
  | { kind: "fail"; result: ToolResult }
  | { kind: "ok"; bytes: Uint8Array; body: string; truncated: boolean }
> => {
  let bodyOut: { kind: "ok"; bytes: Uint8Array; truncated: boolean } | { kind: "aborted" }
  try {
    bodyOut = await readCappedBody(res, maxBytes, signal)
  } catch (e) {
    const msg = errMessage(e)
    return {
      kind: "fail",
      result: errResult(`body read failed: ${msg}`, {
        mode: "error",
        modelVisibleError: msg,
      }),
    }
  }
  if (bodyOut.kind === "aborted") {
    return {
      kind: "fail",
      result: errResult("aborted during body read", {
        mode: "rejected",
        reason: "aborted",
      }),
    }
  }
  const text = bytesToText(bodyOut.bytes, contentType)
  const body = contentType.toLowerCase().startsWith("text/html") ? htmlToMarkdown(text) : text
  return { kind: "ok", bytes: bodyOut.bytes, body, truncated: bodyOut.truncated }
}

/** Inspect the Response — return either an early ToolResult (non-2xx or
 *  binary content) or the validated content-type for the decode phase. */
const inspectResponse = async (
  res: Response,
): Promise<{ kind: "fail"; result: ToolResult } | { kind: "ok"; contentType: string }> => {
  if (!res.ok) {
    return { kind: "fail", result: await nonOkResult(res) }
  }
  const contentType = res.headers.get("content-type") ?? "application/octet-stream"
  if (isBinaryContentType(contentType)) {
    return {
      kind: "fail",
      result: errResult(`non-text content: ${contentType} (use a dedicated tool, e.g. read_image)`),
    }
  }
  return { kind: "ok", contentType }
}

/** Factory — `webFetchTool()` returns the production tool bound to the
 *  global `fetch`; `webFetchTool({ fetcher: fake })` swaps in a test
 *  double. The returned `Tool` is otherwise identical (same name, schema,
 *  posture). */
export const webFetchTool = (options: WebFetchOptions = {}): Tool<WebFetchInput> => {
  const fetcher = options.fetcher ?? globalThis.fetch

  return {
    name: "web_fetch",
    description:
      "Fetch an HTTPS URL and return the page text (HTML→Markdown). " +
      "Read-only; supports redirects; 1 MB response cap (configurable up to 5 MB). " +
      "Rejects http://, file://, and private/loopback addresses (SSRF defense).",
    inputSchema: webFetchInputSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,

    async *execute(input: WebFetchInput, ctx: CoreToolContext): AsyncIterable<ToolEvent> {
      const pre = preflight(input, ctx)
      if (pre.kind === "fail") {
        yield { type: "result", result: pre.result }
        return
      }
      const fetched = await fetchPhase(fetcher, pre.url.toString(), ctx.signal, options.resolveHost)
      if (fetched.kind === "fail") {
        yield { type: "result", result: fetched.result }
        return
      }
      const inspected = await inspectResponse(fetched.res)
      if (inspected.kind === "fail") {
        yield { type: "result", result: inspected.result }
        return
      }
      const decoded = await decodeBodyPhase(
        fetched.res,
        pre.maxBytes,
        ctx.signal,
        inspected.contentType,
      )
      if (decoded.kind === "fail") {
        yield { type: "result", result: decoded.result }
        return
      }
      const output = composeOkOutput({
        url: fetched.res.url || pre.url.toString(),
        status: fetched.res.status,
        contentType: inspected.contentType,
        bytesLen: decoded.bytes.byteLength,
        body: decoded.body,
        truncatedBody: decoded.truncated,
      })
      yield { type: "result", result: { ok: true, output } }
    },
  }
}
