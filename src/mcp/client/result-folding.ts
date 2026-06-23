import type { McpMediaBlock, McpToolAnnotations, McpToolDef } from "../types"

/** Max chars of joined tool-result text we hand back from `callTool`. A
 *  malicious/buggy MCP server returning a huge text blob would otherwise flow
 *  unbounded into memory and the model prompt (DOS). Mirrors the repo-wide
 *  tool-output cap (`@/tool` `output-spill.ts` `DEFAULT_TOOL_OUTPUT_MAX =
 *  200_000`); kept as a local constant because `@/mcp` may not import `@/tool`
 *  (slice isolation, RFC §3.1). Sub-cap results are returned byte-identical. */
const MAX_RESULT_CHARS = 200_000

/** Raw `tools/list` shapes — only the fields we consume are narrowed. */
export interface RawTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
  /** §19.1 — server-advertised `ToolAnnotations` (spec 2025-06-18). UNTRUSTED —
   *  sanitized by {@link sanitizeAnnotations} so only real JSON booleans survive
   *  (a poisoned non-boolean is dropped, never coerced). */
  annotations?: unknown
}
export interface ToolsListResult {
  tools?: RawTool[]
  nextCursor?: string
}
/** §19.3 — extended to carry the non-text content shapes (`image` data/mimeType,
 *  embedded `resource` blob/mimeType) the spec defines. Every field stays
 *  optional so a pure text block is byte-identical to the pre-§19.3 shape. */
export interface ContentBlock {
  type: string
  text?: string
  data?: string
  mimeType?: string
  resource?: unknown
}
export interface ToolsCallResult {
  content?: ContentBlock[]
  isError?: boolean
  /** §19.2 — the spec's typed `structuredContent` payload (a JSON object whose
   *  shape the server's `outputSchema` describes). Carried opaque; the bridge
   *  maps it onto `ToolResult.structured`. Absent ⇒ unchanged text-only result. */
  structuredContent?: unknown
}

/** Narrow an unknown value to a plain record (object, not array/null). Used to
 *  safely walk the `initialize` response's nested `capabilities` slot. */
export const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null

/** §19.1 — lift ONE annotation field iff it arrived as a real JSON boolean. A
 *  poisoned non-boolean (`"true"`, `1`, `{}`, `null`) is DROPPED — never coerced
 *  — so a downstream `=== true` test on the result is always honest. */
const liftBoolHint = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined)

/** §19.1 — sanitize raw server-advertised annotations into the boolean-only
 *  {@link McpToolAnnotations}. Returns `undefined` when the input is not a plain
 *  object OR carries no usable field — so absent/garbage annotations stay absent
 *  (the bridge's predicates remain byte-identical to the pre-annotation path).
 *  The `title` is carried only as a display string (no security meaning). */
export const sanitizeAnnotations = (raw: unknown): McpToolAnnotations | undefined => {
  const obj = asRecord(raw)
  if (obj === null) return undefined
  const out: McpToolAnnotations = {}
  if (typeof obj.title === "string") out.title = obj.title
  const ro = liftBoolHint(obj.readOnlyHint)
  if (ro !== undefined) out.readOnlyHint = ro
  const de = liftBoolHint(obj.destructiveHint)
  if (de !== undefined) out.destructiveHint = de
  const id = liftBoolHint(obj.idempotentHint)
  if (id !== undefined) out.idempotentHint = id
  const ow = liftBoolHint(obj.openWorldHint)
  if (ow !== undefined) out.openWorldHint = ow
  return Object.keys(out).length === 0 ? undefined : out
}

export const mapTool = (t: RawTool): McpToolDef => {
  const annotations = sanitizeAnnotations(t.annotations)
  return {
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.inputSchema ?? { type: "object" },
    ...(annotations !== undefined ? { annotations } : {}),
  }
}

export const joinTextBlocks = (content: ContentBlock[] | undefined): string =>
  (content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text ?? "")
    .join("\n")

/** §19.3 — extract non-text content blocks (image / embedded resource) into the
 *  typed {@link McpMediaBlock} carrier. Text blocks are left to
 *  {@link joinTextBlocks}.
 *
 *  - `image`: needs base64 `data` + a string `mimeType`.
 *  - `resource`: an embedded resource with a base64 `blob` + `mimeType` becomes
 *    a document-class block (a text resource is left to the text join — the
 *    server already exposes that via its content text where present).
 *
 *  Size enforcement (the 5 MB inbound cap + magic-byte sniff) lives in the
 *  BRIDGE where the `@/tool` image-cap policy is reachable — this stays a pure
 *  shape extractor (slice fence: `@/mcp` may not import `@/tool`). A block
 *  missing `data`/`mimeType` is SKIPPED rather than throwing, so a buggy or
 *  malicious server can never crash the call. */
export const extractMedia = (content: ContentBlock[] | undefined): McpMediaBlock[] => {
  const out: McpMediaBlock[] = []
  for (const b of content ?? []) {
    if (b.type === "image") {
      if (typeof b.data === "string" && typeof b.mimeType === "string") {
        out.push({ kind: "image", data: b.data, mimeType: b.mimeType })
      }
    } else if (b.type === "resource") {
      const r = asRecord(b.resource)
      if (r !== null && typeof r.blob === "string" && typeof r.mimeType === "string") {
        out.push({ kind: "resource", data: r.blob, mimeType: r.mimeType })
      }
    }
  }
  return out
}

/** Bound the joined text to {@link MAX_RESULT_CHARS}. Sub-cap input is returned
 *  by reference (byte-identical, no allocation). Over-cap input is truncated to
 *  the head with a clear `[truncated: N bytes omitted]` marker so the model and
 *  any downstream caller can see the result was clipped. */
export const capResultText = (text: string): string => {
  if (text.length <= MAX_RESULT_CHARS) return text
  const omitted = text.length - MAX_RESULT_CHARS
  return `${text.slice(0, MAX_RESULT_CHARS)}\n[truncated: ${omitted} bytes omitted]`
}
