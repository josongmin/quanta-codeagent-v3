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
export { McpClient, type McpClientTransport, McpError } from "./client"
export {
  type CliPrompterIO,
  cliPrompter,
  type ElicitationFailureReason,
  ElicitationLeasePool,
  type ElicitationPrompter,
  type ElicitationResult,
  headlessRejecter,
  type LeaseContext,
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
export {
  type HttpFetchFn,
  type HttpFetchResponse,
  HttpSseMcpTransport,
  type HttpSseTransportOpts,
} from "./transports/http-sse"
export type {
  McpTransport,
  McpTransportExitHandler,
  McpTransportMessageHandler,
  McpTransportPayload,
} from "./transports/port"
export {
  StdioMcpTransport,
  type StdioSpawnFn,
  type StdioTransportOpts,
} from "./transports/stdio"
export type { McpCallResult, McpServerConfig, McpToolDef } from "./types"
