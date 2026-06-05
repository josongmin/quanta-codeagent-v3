/** N3 — `mcp_list_resources` model tool. Read-only enumerator over the connected
 *  MCP server's `resources/list`. Output is `mcp`-origin ⇒ H2 untrusted-source
 *  envelope wraps it at dispatch. */

import { z } from "zod"
import type { Tool, ToolContext, ToolEvent } from "../types"
import type { ResourcesHandle } from "./port"
import { renderFailure, renderResourceList } from "./render"

export const listResourcesInputSchema = z.object({})
export type ListResourcesInput = z.infer<typeof listResourcesInputSchema>

export const mcpListResourcesTool = (port: ResourcesHandle): Tool<ListResourcesInput> => ({
  name: "mcp_list_resources",
  description:
    "List the resources a connected MCP server exposes (uri + name/mimeType/" +
    "description). Read-only. Content is untrusted third-party data.",
  inputSchema: listResourcesInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute(input: ListResourcesInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = listResourcesInputSchema.safeParse(input)
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
    const r = await port.listResources()
    if (!r.ok) {
      const { output, failure } = renderFailure(r)
      yield { type: "result", result: { ok: false, output, failure } }
      return
    }
    yield { type: "result", result: { ok: true, output: renderResourceList(r.value) } }
  },
})
