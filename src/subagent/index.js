/**
 * Subagent slice — public API.
 *
 * Wire-up the main thread (the only allowed cross-importer, via @/agent) does:
 *   const agentTool = createAgentTool({ runner, maxDepth: 3 })
 *   const taskRegistry = agentTool.registry
 *   // merge into a fresh ToolRegistry (constructor-only):
 *   extraTools.push(
 *     agentTool,
 *     createTaskOutputTool(taskRegistry),
 *     createTaskStopTool(taskRegistry),
 *   )
 * `createAgentTool` mints a fresh `TaskRegistry` when none is passed and
 * re-exposes whichever instance it used as `.registry`; the host reads that
 * back and threads the SAME instance into the Task* tools so all three observe
 * the same background tasks. See `src/agent/features.ts:174-179` for the live
 * wiring. `runner` is a forked `runAgent` (depth+1, filtered registry, own
 * memory) and MUST chain `req.signal` into the child loop so `task_stop`
 * actually unwinds the fork.
 *
 * Recommended AgentConfig field:
 *   subagent?: { runner: SubagentRunner; maxDepth?: number }
 * The host constructs the runner from its own loop and threads maxDepth here.
 */
export { createAgentTool } from "./agent-tool";
export { dispatchSubagent6, isSubagent6Tool } from "./dispatch-6";
export { handleCloseAgent, handleExecCommand, handleSendInput, handleSpawnAgent, handleWaitAgent, handleWriteStdin, InputChannelRegistry, MAX_PTY, PtyTable, } from "./handlers-6";
export { TaskRegistry } from "./registry";
export { createTaskOutputTool, createTaskStopTool } from "./task-tools";
export { SUBAGENT_6_TOOL_CONTRACTS, SUBAGENT_6_TOOL_NAMES, } from "./tools-6";
