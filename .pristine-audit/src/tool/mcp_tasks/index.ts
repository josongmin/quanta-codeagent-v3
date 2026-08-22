/** ADR-0196 — MCP tasks tools (model-facing).
 *
 *  Three caller-wired tools, mirroring the `shadow*` / `branch_search` pattern:
 *  registered ONLY when the apps layer wires a `TasksHandle` (the duck-typed
 *  mirror of `McpTasksPort`). Not part of `defaultTools` — default-OFF +
 *  byte-identical for sessions that never opt in. */

import type { Tool } from "../types"
import { cancelMcpTaskTool } from "./cancel_task"
import { getMcpTaskTool } from "./get_task"
import { listMcpTasksTool } from "./list_tasks"
import type { TasksHandle } from "./port"

export {
  type CancelTaskInput,
  cancelMcpTaskTool,
  cancelTaskInputSchema,
} from "./cancel_task"
export { type GetTaskInput, getMcpTaskTool, getTaskInputSchema } from "./get_task"
export {
  type ListTasksInput,
  listMcpTasksTool,
  listTasksInputSchema,
} from "./list_tasks"
export type {
  TasksCancelResult,
  TasksHandle,
  TasksListOutcome,
  TasksListPage,
  TasksTaskInfo,
  TasksTaskResult,
  TasksTaskState,
} from "./port"

/** Build all three tools wired to a single `TasksHandle`. Order: read-only
 *  first (list → get) then destructive (cancel). */
export const mcpTasksTools = (port: TasksHandle): Tool[] => [
  listMcpTasksTool(port) as Tool,
  getMcpTaskTool(port) as Tool,
  cancelMcpTaskTool(port) as Tool,
]
