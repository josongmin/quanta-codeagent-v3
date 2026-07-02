/** N3 — MCP resource/prompt tools (model-facing).
 *
 *  Five caller-wired tools over the H19-landed `McpClient` `resources/*` +
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
import { mcpListResourceTemplatesTool } from "./list_resource_templates"
import { mcpListResourcesTool } from "./list_resources"
import type { ResourcesHandle } from "./port"
import { mcpReadResourceTool } from "./read_resource"
import { mcpReadResourceDirTool } from "./read_resource_dir"

export { type GetPromptInput, getPromptInputSchema, mcpGetPromptTool } from "./get_prompt"
export { type ListPromptsInput, listPromptsInputSchema, mcpListPromptsTool } from "./list_prompts"
export {
  type ListResourceTemplatesInput,
  listResourceTemplatesInputSchema,
  mcpListResourceTemplatesTool,
} from "./list_resource_templates"
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
  ResourceTemplateEntry,
} from "./port"
export {
  mcpReadResourceTool,
  type ReadResourceInput,
  readResourceInputSchema,
  type ReadResourceToolOptions,
} from "./read_resource"
export {
  mcpReadResourceDirTool,
  type ReadResourceDirInput,
  readResourceDirInputSchema,
} from "./read_resource_dir"
export {
  BLOB_MAX_BYTES,
  filterDirectChildren,
  MAX_OUTPUT,
  mapFailure,
  renderPromptList,
  renderPromptResult,
  renderResourceContent,
  renderResourceContentSavingBlobs,
  renderResourceDirList,
  renderResourceList,
  renderResourceTemplateList,
} from "./render"

/** Build all six tools wired to a single `ResourcesHandle`. Stable order:
 *  list_resources → list_resource_templates → read_resource → read_resource_dir
 *  → list_prompts → get_prompt. All read-only EXCEPT `read_resource`, whose
 *  blob-to-disk write makes it mutating (`isReadOnly() === false`). */
export const mcpResourcesTools = (port: ResourcesHandle): Tool[] => [
  mcpListResourcesTool(port) as Tool,
  mcpListResourceTemplatesTool(port) as Tool,
  mcpReadResourceTool(port) as Tool,
  mcpReadResourceDirTool(port) as Tool,
  mcpListPromptsTool(port) as Tool,
  mcpGetPromptTool(port) as Tool,
]
