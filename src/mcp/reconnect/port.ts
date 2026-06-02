/** Ports for the MCP auto-restart supervisor (ADR-0435).
 *
 *  The supervisor depends ONLY on these structural shapes — never on the
 *  concrete `McpClient` / `IsolatedMcpClient` (DIP). Both concrete clients
 *  already expose `start`/`listTools`/`callTool`/`stop`; §5 adds the public
 *  `onExit` to each so they satisfy {@link SupervisableMcpClient} without the
 *  supervisor reaching across to a concrete type. */

import type { McpCallResult, McpServerConfig, McpToolDef } from "../types"

/** Structural surface that both `McpClient` and `IsolatedMcpClient` satisfy.
 *  The supervisor swaps instances of this behind a stable tool name. */
export interface SupervisableMcpClient {
  start(): Promise<void>
  listTools(): Promise<McpToolDef[]>
  callTool(name: string, args: unknown): Promise<McpCallResult>
  stop(): Promise<void>
  /** Subscribe to a one-shot transport/process exit notification. Returns an
   *  unsubscribe. When no handler is registered the client's exit path is
   *  byte-identical to today (the fan-out loop is a no-op). */
  onExit(handler: (reason?: string) => void): () => void
}

/** How the supervisor builds a fresh client instance on each restart. Injected
 *  so tests provide a fake double and the CLI selects the legacy vs isolated
 *  client without the supervisor knowing either concrete type. */
export type McpClientFactory = (config: McpServerConfig) => SupervisableMcpClient
