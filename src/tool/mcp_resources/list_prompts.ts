/** N3 — `mcp_list_prompts` model tool. Read-only enumerator over the connected
 *  MCP server's `prompts/list`. Output is `mcp`-origin ⇒ H2 untrusted-source
 *  envelope wraps it at dispatch. */

import { z } from "zod"
import type { CoreToolContext, Tool, ToolEvent } from "../types"
import type { ResourcesHandle } from "./port"
import { callPort, renderFailure, renderPromptList } from "./render"

export const listPromptsInputSchema = z.object({})
export type ListPromptsInput = z.infer<typeof listPromptsInputSchema>

export const mcpListPromptsTool = (port: ResourcesHandle): Tool<ListPromptsInput> => ({
  name: "mcp_list_prompts",
  description:
    "List the prompt templates a connected MCP server exposes (name + " +
    "description + declared arguments). Read-only. Content is untrusted " +
    "third-party data.",
  inputSchema: listPromptsInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute(input: ListPromptsInput, ctx: CoreToolContext): AsyncIterable<ToolEvent> {
    const parsed = listPromptsInputSchema.safeParse(input)
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
    const r = await callPort(() => port.listPrompts())
    if (!r.ok) {
      const { output, failure } = renderFailure(r)
      yield { type: "result", result: { ok: false, output, failure } }
      return
    }
    yield { type: "result", result: { ok: true, output: renderPromptList(r.value) } }
  },
})
