/** H19 (jun-3-misc §3) — MCP resources / prompts / roots slice barrel. */

export {
  type CappedResourceRead,
  parsePromptGet,
  parsePromptList,
  parseResourceList,
  parseResourceRead,
  parseResourceReadCapped,
  RESOURCE_READ_MAX_CONTENT_CHARS,
  resourceContentChars,
} from "./codec"
export {
  isRootsMethod,
  MCP_ROOTS_LIST_METHOD,
  type RootsListResponse,
  routeRootsList,
} from "./inbound-router"
export {
  isResourceNotificationMethod,
  type McpResourceNotification,
  type McpResourceObserver,
  PROMPT_LIST_CHANGED_METHOD,
  parseResourceNotification,
  RESOURCE_LIST_CHANGED_METHOD,
  RESOURCE_UPDATED_METHOD,
  routeResourceNotification,
} from "./notifications"
export type {
  McpPrompt,
  McpPromptArgument,
  McpPromptMessage,
  McpPromptResult,
  McpResource,
  McpResourceContent,
  McpResourceFailure,
  McpResult,
  McpRoot,
  RootsProviderPort,
} from "./port"
