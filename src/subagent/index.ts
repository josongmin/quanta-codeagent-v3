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

export type { AgentMeta } from "./agent-meta"
export { AgentMetaRegistry } from "./agent-meta"
export type { AgentToolOptions } from "./agent-tool"
export { createAgentTool } from "./agent-tool"
export { createSubagent6Tools, type Subagent6ToolSet } from "./agent-tools-6"
export {
  type AgentTypeClass,
  type AgentTypeValidation,
  classifyAgentType,
  isSubagentType,
  SUBAGENT_KINDS,
  type SubagentAgentType,
  type SubagentType,
  type ValidateAgentTypeOpts,
  validateAgentType,
} from "./agent-type"
export { dispatchSubagent6, isSubagent6Tool, type Subagent6Deps } from "./dispatch-6"
export {
  DEFAULT_WAIT_TIMEOUT_POLICY,
  handleCloseAgent,
  handleExecCommand,
  handleSendInput,
  handleSpawnAgent,
  handleWaitAgent,
  handleWriteStdin,
  InputChannelRegistry,
  MAX_PTY,
  PtyTable,
  type WaitTimeoutPolicy,
} from "./handlers-6"
export {
  createIntrospectTools,
  type FollowupTaskInput,
  FollowupTaskInputSchema,
  type FollowupTaskOutput,
  handleFollowupTask,
  handleListAgents,
  type IntrospectError,
  type IntrospectToolsDeps,
  type ListAgentsInput,
  ListAgentsInputSchema,
  type ListAgentsOutput,
  type ListedAgent,
  type MailboxSendPort,
} from "./introspect-tools"
export { assignNickname, MAESTRO_NICKNAMES, nextSequentialNickname } from "./nicknames"
export type { TaskRecord, TaskRegistryOptions, TaskStatus } from "./registry"
export { TaskRegistry } from "./registry"
export {
  createTaskOutputTool,
  createTaskStopTool,
  type TaskOutputTimeoutPolicy,
} from "./task-tools"
export { createTeamRegistry, type TeamRegistryPort } from "./team/registry"
export {
  SUBAGENT_6_TOOL_CONTRACTS,
  SUBAGENT_6_TOOL_NAMES,
  type Subagent6ToolName,
} from "./tools-6"
export type { GateWaitResult, GateWakeResult } from "./turn-gate"
export { SubagentTurnGate } from "./turn-gate"
export type { WakeOutcome, Waker } from "./turn-wake"
export { TurnWakeRegistry } from "./turn-wake"
export type {
  SubagentRequest,
  SubagentResult,
  SubagentRunner,
  TaskBudget,
  TaskKind,
} from "./types"
