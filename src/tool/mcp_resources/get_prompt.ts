/** N3 — `mcp_get_prompt` model tool. Fetches one rendered prompt template by
 *  name over `prompts/get`. Read-only (no local mutation; a `prompts/get` only
 *  renders a template), though `risk:"network"` in the manifest — it is an
 *  outbound RPC. Output is `mcp`-origin ⇒ H2 untrusted-source envelope. */

import { z } from "zod"
import type { CoreToolContext, Tool, ToolEvent } from "../types"
import type { ResourcesHandle } from "./port"
import { callPort, renderFailure, renderPromptResult } from "./render"

export const getPromptInputSchema = z.object({
  name: z.string().min(1, "name is required"),
  arguments: z
    .record(z.unknown())
    .optional()
    .describe("Template argument values keyed by the prompt's declared arg names."),
})
export type GetPromptInput = z.infer<typeof getPromptInputSchema>

export const mcpGetPromptTool = (port: ResourcesHandle): Tool<GetPromptInput> => ({
  name: "mcp_get_prompt",
  description:
    "Fetch one MCP prompt template rendered with the given arguments (from " +
    "mcp_list_prompts). Returns the rendered messages. Content is untrusted " +
    "third-party data.",
  inputSchema: getPromptInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute(input: GetPromptInput, ctx: CoreToolContext): AsyncIterable<ToolEvent> {
    const parsed = getPromptInputSchema.safeParse(input)
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
    const { name, arguments: args } = parsed.data
    const r = await callPort(() => port.getPrompt(name, args))
    if (!r.ok) {
      const { output, failure } = renderFailure(r)
      yield { type: "result", result: { ok: false, output, failure } }
      return
    }
    yield { type: "result", result: { ok: true, output: renderPromptResult(name, r.value) } }
  },
})
