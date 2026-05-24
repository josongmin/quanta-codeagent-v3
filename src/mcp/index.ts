/** MCP (Model Context Protocol) stdio client — public API.
 *
 *  Selective re-export only: framing internals (LineReader, codec) stay
 *  private to the slice. */

export {
  type CapabilityNegotiator,
  defaultNegotiator,
  fullNegotiator,
  type McpCapabilityRecord,
} from "./capabilities"
export { McpClient, McpError } from "./client"
export {
  type CliPrompterIO,
  cliPrompter,
  type ElicitationFailureReason,
  type ElicitationPrompter,
  type ElicitationResult,
  headlessRejecter,
} from "./elicitation"
export {
  DefaultTaskStore,
  defaultTasksPort,
  type McpTaskInfo,
  type McpTasksPort,
  pollTask,
  type TaskCancelResult,
  type TaskListOutcome,
  type TaskListPage,
  type TaskResult,
  type TaskState,
  TERMINAL_TASK_STATES,
} from "./tasks"
export type { McpCallResult, McpServerConfig, McpToolDef } from "./types"
