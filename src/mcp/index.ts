/** MCP (Model Context Protocol) stdio client — public API.
 *
 *  Selective re-export only: framing internals (LineReader, codec) stay
 *  private to the slice. */

export {
  type CapabilityNegotiator,
  defaultNegotiator,
  type FullNegotiatorOptions,
  fullNegotiator,
  type McpCapabilityRecord,
} from "./capabilities"
export {
  extractMedia,
  McpClient,
  type McpClientTransport,
  McpError,
  sanitizeAnnotations,
} from "./client"
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
export { headlessOAuthRejecter, type McpOAuthProviderPort } from "./oauth"
export {
  type BackoffPolicy,
  backoffDelay,
  DEFAULT_BACKOFF_POLICY,
  type McpClientFactory,
  McpReconnectSupervisor,
  type PendingPolicy,
  type SupervisableMcpClient,
  type SupervisorDeps,
  type SupervisorSnapshot,
  type SupervisorState,
} from "./reconnect"
export {
  isResourceNotificationMethod,
  isRootsMethod,
  MCP_ROOTS_LIST_METHOD,
  type McpPrompt,
  type McpPromptArgument,
  type McpPromptMessage,
  type McpPromptResult,
  type McpResource,
  type McpResourceContent,
  type McpResourceFailure,
  type McpResourceNotification,
  type McpResourceObserver,
  type McpResult,
  type McpRoot,
  PROMPT_LIST_CHANGED_METHOD,
  RESOURCE_LIST_CHANGED_METHOD,
  RESOURCE_UPDATED_METHOD,
  type RootsListResponse,
  type RootsProviderPort,
  routeResourceNotification,
  routeRootsList,
} from "./resources"
export {
  type CreateMessageRequest,
  type CreateMessageResult,
  headlessSamplingRejecter,
  isSamplingMethod,
  MCP_SAMPLING_METHOD,
  routeSampling,
  SAMPLING_DECLINED_CODE,
  type SamplingDeclineReason,
  type SamplingHandlerPort,
  type SamplingMessage,
  type SamplingOutcome,
  type SamplingResponse,
} from "./sampling"
export {
  clientTasksPort,
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
  type TasksRpc,
  TERMINAL_TASK_STATES,
  tasksPortOver,
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
export type {
  McpCallResult,
  McpMediaBlock,
  McpServerConfig,
  McpToolAnnotations,
  McpToolDef,
} from "./types"
