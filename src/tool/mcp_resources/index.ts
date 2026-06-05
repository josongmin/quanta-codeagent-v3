/** N3 — MCP resource/prompt tools (model-facing).
 *
 *  Four caller-wired tools over the H19-landed `McpClient` `resources/*` +
 *  `prompts/*` methods, surfaced through a DUCK-TYPED `ResourcesHandle` (the
 *  `@/tool` fence forbids `@/tool`→`@/mcp`). Mirror of `@/tool/mcp_tasks`:
 *  registered ONLY when the apps layer wires a `ResourcesHandle` (via
 *  `DefaultToolPorts.mcpResources`) — NOT part of `defaultTools`. Default-OFF +
 *  byte-identical for sessions that never opt in.
 *
 *  Untrusted content: these tools register through the `mcp`-origin array, so
 *  `deriveProvenance(name,"mcp") === "mcp"` ⇒ the H2/ADR-0471 `<untrusted-source>`
 *  envelope wraps their output at the dispatch seam. No extra security wiring. */

import type { Tool } from "../types"
import { mcpGetPromptTool } from "./get_prompt"
import { mcpListPromptsTool } from "./list_prompts"
import { mcpListResourcesTool } from "./list_resources"
import type { ResourcesHandle } from "./port"
import { mcpReadResourceTool } from "./read_resource"

export { type GetPromptInput, getPromptInputSchema, mcpGetPromptTool } from "./get_prompt"
export { type ListPromptsInput, listPromptsInputSchema, mcpListPromptsTool } from "./list_prompts"
export {
  type ListResourcesInput,
  listResourcesInputSchema,
  mcpListResourcesTool,
} from "./list_resources"
export type {
  HandleResult,
  PromptArgument,
  PromptEntry,
  PromptMessage,
  PromptResult,
  ResourceBlock,
  ResourceEntry,
  ResourcesFailureReason,
  ResourcesHandle,
} from "./port"
export {
  mcpReadResourceTool,
  type ReadResourceInput,
  readResourceInputSchema,
} from "./read_resource"
export {
  MAX_OUTPUT,
  mapFailure,
  renderPromptList,
  renderPromptResult,
  renderResourceContent,
  renderResourceList,
} from "./render"

/** Build all four tools wired to a single `ResourcesHandle`. Stable order:
 *  list_resources → read_resource → list_prompts → get_prompt (all read-only). */
export const mcpResourcesTools = (port: ResourcesHandle): Tool[] => [
  mcpListResourcesTool(port) as Tool,
  mcpReadResourceTool(port) as Tool,
  mcpListPromptsTool(port) as Tool,
  mcpGetPromptTool(port) as Tool,
]
