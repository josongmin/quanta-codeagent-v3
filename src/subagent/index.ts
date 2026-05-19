/**
 * Subagent slice — public API.
 *
 * Wire-up the main thread (the only allowed cross-importer, via @/agent) does:
 *   const reg = new TaskRegistry()
 *   const agent = createAgentTool({ runner, maxDepth: 3, registry: reg })
 *   registry.register([
 *     agent,
 *     createTaskOutputTool(reg),
 *     createTaskStopTool(reg),
 *   ])
 * where `runner` is a forked runAgent (depth+1, filtered registry, own memory).
 *
 * Recommended AgentConfig field:
 *   subagent?: { runner: SubagentRunner; maxDepth?: number }
 * The host constructs the runner from its own loop and threads maxDepth here.
 */
export { createAgentTool } from "./agent-tool"
export type { AgentToolOptions } from "./agent-tool"
export { TaskRegistry } from "./registry"
export type { TaskRecord, TaskStatus } from "./registry"
export { createTaskOutputTool, createTaskStopTool } from "./task-tools"
export type {
  SubagentRequest,
  SubagentResult,
  SubagentRunner,
  TaskBudget,
} from "./types"
