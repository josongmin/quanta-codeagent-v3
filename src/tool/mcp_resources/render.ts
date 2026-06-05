/** N3 — PURE rendering + failure-mapping helpers for the MCP resource/prompt
 *  tools. Lives in the tool slice (no `@/mcp`); the analogue of
 *  `mcp_tasks/list_tasks.ts`'s result-string assembly.
 *
 *  Resource/prompt CONTENT is third-party, adversary-controllable DATA. These
 *  helpers NEVER inline base64 blobs (token blowout) and cap rendered text so a
 *  hostile/large resource cannot blow up the transcript or memory. The output
 *  string is later wrapped by the H2/ADR-0471 `<untrusted-source>` envelope at
 *  the dispatch seam because the tool is registered through the `mcp`-origin
 *  array — these helpers do not (and must not) re-implement that. */

import type { ToolFailure } from "../types"
import type {
  HandleResult,
  PromptEntry,
  PromptMessage,
  PromptResult,
  ResourceBlock,
  ResourceEntry,
  ResourcesFailureReason,
} from "./port"

/** Defensive cap on the rendered tool output. A hostile server can return
 *  megabytes of text; we cap the assembled string the same way the tasks tool
 *  caps its listing (`list_tasks.ts:14`). Not a magic threshold invented here —
 *  the same 50k value the sibling tool already uses. */
export const MAX_OUTPUT = 50_000

export const truncate = (s: string): string =>
  s.length <= MAX_OUTPUT ? s : `${s.slice(0, MAX_OUTPUT)}\n… (truncated)`

/** Map a typed `HandleResult` failure onto a model-visible string + a typed
 *  `ToolFailure`. `unsupported` ⇒ the server never advertised the capability
 *  (honest, cheap); the rest are operational failures the loop survives. */
export const mapFailure = (
  reason: ResourcesFailureReason,
  message: string,
): { output: string; failure: ToolFailure } => {
  switch (reason) {
    case "unsupported":
      return {
        output: `unsupported: the connected MCP server does not advertise this capability`,
        failure: { mode: "rejected", reason: "unsupported" },
      }
    case "too-large":
      return {
        output: `too-large: the server returned content exceeding the size cap (${message})`,
        failure: { mode: "rejected", reason: "too-large" },
      }
    case "malformed":
      return {
        output: `malformed: the server returned an unparseable response (${message})`,
        failure: { mode: "error", modelVisibleError: "malformed-mcp-response" },
      }
    case "transport":
      return {
        output: `transport: the MCP request failed (${message})`,
        failure: { mode: "error", modelVisibleError: "mcp-transport-error" },
      }
  }
}

/** narrow a `HandleResult` failure branch to the rendered pair. */
export const renderFailure = <T>(
  r: Extract<HandleResult<T>, { ok: false }>,
): { output: string; failure: ToolFailure } => mapFailure(r.reason, r.message)

// --- resources -------------------------------------------------------------

export const renderResourceList = (entries: ReadonlyArray<ResourceEntry>): string => {
  if (entries.length === 0) return "(no resources)"
  const lines = entries.map((e) => {
    const name = e.name !== undefined ? ` — ${e.name}` : ""
    const mime = e.mimeType !== undefined ? ` (${e.mimeType})` : ""
    const desc = e.description !== undefined ? `: ${e.description}` : ""
    return `  - ${e.uri}${name}${mime}${desc}`
  })
  return truncate([`${entries.length} resource${entries.length === 1 ? "" : "s"}:`, ...lines].join("\n"))
}

/** Render `resources/read` content blocks. Text blocks are concatenated with a
 *  source header; BLOB blocks are NEVER inlined (a placeholder is emitted so the
 *  model knows binary content exists without flooding the transcript with
 *  base64). Output is capped. */
export const renderResourceContent = (uri: string, blocks: ReadonlyArray<ResourceBlock>): string => {
  if (blocks.length === 0) return `# ${uri}\n(empty resource — no content blocks)`
  const parts: string[] = []
  for (const b of blocks) {
    const mime = b.mimeType !== undefined ? ` (${b.mimeType})` : ""
    if (typeof b.text === "string") {
      parts.push(`# ${b.uri}${mime}\n${b.text}`)
    } else if (typeof b.blob === "string") {
      parts.push(`[binary block ${b.uri}${mime}, ${b.blob.length} base64 chars — not inlined]`)
    } else {
      parts.push(`[empty block ${b.uri}${mime} — no text or blob]`)
    }
  }
  return truncate(parts.join("\n\n"))
}

// --- prompts ---------------------------------------------------------------

export const renderPromptList = (entries: ReadonlyArray<PromptEntry>): string => {
  if (entries.length === 0) return "(no prompts)"
  const lines = entries.map((e) => {
    const desc = e.description !== undefined ? `: ${e.description}` : ""
    const args =
      e.arguments !== undefined && e.arguments.length > 0
        ? `\n      args: ${e.arguments
            .map((a) => `${a.name}${a.required === true ? "*" : ""}`)
            .join(", ")}`
        : ""
    return `  - ${e.name}${desc}${args}`
  })
  return truncate([`${entries.length} prompt${entries.length === 1 ? "" : "s"}:`, ...lines].join("\n"))
}

/** Render one prompt message. Text content (string, or a `{type:"text",text}`
 *  block) is rendered inline; any other content shape (image / resource union —
 *  `content` is `unknown` by spec) gets a typed placeholder, NOT a parse attempt
 *  (the codec owner is the source slice). NEVER throws. */
const renderMessageContent = (content: unknown): string => {
  if (typeof content === "string") return content
  if (typeof content === "object" && content !== null && !Array.isArray(content)) {
    const rec = content as Record<string, unknown>
    if (rec.type === "text" && typeof rec.text === "string") return rec.text
    const kind = typeof rec.type === "string" ? rec.type : "unknown"
    return `[non-text content block (${kind}) — not rendered]`
  }
  return `[non-text content — not rendered]`
}

export const renderPromptResult = (name: string, result: PromptResult): string => {
  const header = result.description !== undefined ? `# ${name} — ${result.description}` : `# ${name}`
  const lines = (result.messages as ReadonlyArray<PromptMessage>).map(
    (m) => `${m.role}: ${renderMessageContent(m.content)}`,
  )
  if (lines.length === 0) return truncate(`${header}\n(no messages)`)
  return truncate([header, ...lines].join("\n"))
}
