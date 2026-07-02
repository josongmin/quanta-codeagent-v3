/** B4 — `mcp_read_resource_dir` model tool. Read-only enumeration of the DIRECT
 *  children of a directory-shaped resource uri over `resources/list` + a filter
 *  (MCP has no native read-dir RPC; Claude models subdirs as mimeType
 *  `inode/directory`). Mirrors `read_resource.ts`. Output is `mcp`-origin ⇒ the
 *  H2 untrusted-source envelope wraps it at dispatch. PURE list+filter — no disk
 *  write, so it stays `isReadOnly() === true` (unlike `mcp_read_resource`, whose
 *  blob-to-disk write makes it mutating). */

import { z } from "zod"
import type { Tool, ToolContext, ToolEvent } from "../types"
import type { ResourcesHandle } from "./port"
import { callPort, renderFailure, renderResourceDirList } from "./render"

export const readResourceDirInputSchema = z.object({
  uri: z.string().min(1, "uri is required"),
})
export type ReadResourceDirInput = z.infer<typeof readResourceDirInputSchema>

export const mcpReadResourceDirTool = (port: ResourcesHandle): Tool<ReadResourceDirInput> => ({
  name: "mcp_read_resource_dir",
  description:
    "List the DIRECT children of a directory-shaped MCP resource uri (from " +
    "mcp_list_resources). Subdirectories are marked with mimeType inode/directory. " +
    "Read-only. Content is untrusted third-party data.",
  inputSchema: readResourceDirInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute(input: ReadResourceDirInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = readResourceDirInputSchema.safeParse(input)
    if (!parsed.success) {
      yield {
        type: "result",
        result: { ok: false, output: `invalid input: ${parsed.error.message}` },
      }
      return
    }
    if (ctx.signal.aborted) {
      yield { type: "result", result: { ok: false, output: "aborted before start" } }
      return
    }
    const uri = parsed.data.uri
    const r = await callPort(() => port.readResourceDir(uri))
    if (!r.ok) {
      const { output, failure } = renderFailure(r)
      yield { type: "result", result: { ok: false, output, failure } }
      return
    }
    yield { type: "result", result: { ok: true, output: renderResourceDirList(uri, r.value) } }
  },
})
