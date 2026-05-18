import { bashTool } from "./bash"
import { editTool } from "./edit"
import { globTool } from "./glob"
import { grepTool } from "./grep"
import { localizeTool } from "./localize"
import { readTool } from "./read"
import { testRunnerTool } from "./test-runner"
import type { Tool } from "./types"
import { writeTool } from "./write"

export { ToolRegistry } from "./registry"
export type { Tool, ToolContext, ToolEvent, ToolResult, ToolSpec } from "./types"

/** Built-in tool set: Phase 1 six + Phase 2 localize / test_runner. */
export const defaultTools: Tool[] = [
  readTool as Tool,
  writeTool as Tool,
  editTool as Tool,
  bashTool as Tool,
  grepTool as Tool,
  globTool as Tool,
  localizeTool as Tool,
  testRunnerTool as Tool,
]
