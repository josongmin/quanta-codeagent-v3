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
  unsupportedTypeMarker,
} from "./client"
export {
  type CliPrompterIO,
  cliPrompter,
  type ElicitationFailureReason,
  ElicitationLeasePool,
  type ElicitationPrompter,
  type ElicitationResult,
  // jul-03 A1 — AskUserQuestion structured-option parity (surface renderers +
  // hellgates import the option shape/label helper from `@/mcp`).
  type EnumOption,
  enumOptionLabel,
  headlessRejecter,
  type LeaseContext,
  // TICKET-22 — URL elicitation variant (hellgates import these from `@/mcp`).
  type UrlRequest,
  urlRequestSchema,
} from "./elicitation"
export { headlessOAuthRejecter, type McpOAuthProviderPort } from "./oauth"
export {
  isProgressMethod,
  type McpProgress,
  type McpProgressHandler,
  PROGRESS_MAX_MESSAGE_CHARS,
  PROGRESS_METHOD,
  parseProgress,
} from "./progress"
export {
  isSupportedProtocolVersion,
  LATEST_PROTOCOL_VERSION,
  PROTOCOL_DOWNGRADE_FLOOR,
  resolveOfferedVersion,
  SUPPORTED_PROTOCOL_VERSIONS,
  type SupportedProtocolVersion,
} from "./protocol-version"
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
  type McpCompletionArgument,
  type McpCompletionRef,
  type McpCompletionResult,
  type McpPrompt,
  type McpPromptArgument,
  type McpPromptMessage,
  type McpPromptResult,
  type McpResource,
  type McpResourceContent,
  type McpResourceFailure,
  type McpResourceNotification,
  type McpResourceObserver,
  type McpResourceTemplate,
  type McpResult,
  type McpRoot,
  PROMPT_LIST_CHANGED_METHOD,
  parseCompletionResult,
  parseResourceTemplateList,
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
export { MAX_RESULT_CHARS, McpServer, type McpServerCtorOptions } from "./server"
// TICKET-19 reverse-MCP — quanta AS an MCP server (the inverse of the client).
// `McpServer` is the inbound JSON-RPC dispatcher; `buildMcpServer` is the pure
// read-only-whitelist security boundary. The real `dispatchTool` + registry are
// bound at the composition root (`src/apps/cli/mcp-server-setup.ts`); these
// exports take DUCK-TYPED ports so the `@/mcp` slice never imports `@/agent`.
export {
  buildMcpServer,
  DEFAULT_PAGE_SIZE,
  type McpServerOptions,
  type ServerToolSpec,
  type ToolCallPort,
  type ToolListSource,
} from "./server-builder"
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
