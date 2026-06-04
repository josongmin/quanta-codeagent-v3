/** H18 — MCP HTTP-server OAuth port (the DI seam) + its safe default.
 *
 *  The connectors-backed implementation lives in the host layer
 *  (`@/host/runtime/mcp-oauth-provider`) — `@/mcp` ships only the seam. */

export { headlessOAuthRejecter } from "./headless-rejecter"
export type { McpOAuthProviderPort } from "./port"
