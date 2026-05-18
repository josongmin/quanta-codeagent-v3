import { bashTool } from "./bash"
import { editTool } from "./edit"
import { globTool } from "./glob"
import { grepTool } from "./grep"
import { readTool } from "./read"
import type { Tool } from "./types"
import { writeTool } from "./write"

export { ToolRegistry } from "./registry"
export type { Tool, ToolContext, ToolResult, ToolSpec } from "./types"

/** Phase 1 built-in tool set. */
export const defaultTools: Tool[] = [
  readTool as Tool,
  writeTool as Tool,
  editTool as Tool,
  bashTool as Tool,
  grepTool as Tool,
  globTool as Tool,
]
