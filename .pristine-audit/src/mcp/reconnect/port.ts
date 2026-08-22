/** Ports for the MCP auto-restart supervisor (ADR-0435).
 *
 *  The supervisor depends ONLY on these structural shapes — never on the
 *  concrete `McpClient` / `IsolatedMcpClient` (DIP). Both concrete clients
 *  already expose `start`/`listTools`/`callTool`/`stop`; §5 adds the public
 *  `onExit` to each so they satisfy {@link SupervisableMcpClient} without the
 *  supervisor reaching across to a concrete type. */

import type { McpProgressHandler } from "../progress"
import type {
  McpPrompt,
  McpPromptResult,
  McpResource,
  McpResourceContent,
  McpResourceTemplate,
  McpResult,
} from "../resources/port"
import type { McpCallResult, McpServerConfig, McpToolDef } from "../types"

/** Structural surface that both `McpClient` and `IsolatedMcpClient` satisfy.
 *  The supervisor swaps instances of this behind a stable tool name. */
export interface SupervisableMcpClient {
  start(): Promise<void>
  listTools(): Promise<McpToolDef[]>
  // §19.4 — optional per-call progress sink. The optional 3rd param keeps every
  // existing 2-arg implementer (e.g. IsolatedMcpClient) structurally valid.
  callTool(
    name: string,
    args: unknown,
    opts?: { onProgress?: McpProgressHandler },
  ): Promise<McpCallResult>
  stop(): Promise<void>
  /** Subscribe to a one-shot transport/process exit notification. Returns an
   *  unsubscribe. When no handler is registered the client's exit path is
   *  byte-identical to today (the fan-out loop is a no-op). */
  onExit(handler: (reason?: string) => void): () => void
  /** ADR-0435 follow-up — OPTIONAL tasks surface. `McpClient` exposes both;
   *  `IsolatedMcpClient` exposes neither (so it stays a valid supervisable
   *  client). The supervisor reads these off whatever its CURRENT live client
   *  is, so the tasks binding is re-resolved per call and survives a restart.
   *  A client that omits `serverSupportsTasks` ⇒ the supervisor reports no
   *  tasks capability ⇒ no `mcp_task_*` tools (byte-identical default-OFF). */
  serverSupportsTasks?(): boolean
  /** §1.2 (ticket-09) — OPTIONAL. The supervisor reads the last SSE event id off
   *  the dying client and seeds it into the replacement's config
   *  (`resumeFromEventId`) so the new GET sends `Last-Event-ID`. A client that
   *  omits this (or returns null) ⇒ no resume hint (byte-identical fresh GET). */
  getLastEventId?(): string | null
  /** ADR-0435 follow-up — OPTIONAL outbound JSON-RPC dispatch for `tasks/*`.
   *  Present iff `serverSupportsTasks` is. */
  requestRaw?(method: string, params?: unknown): Promise<unknown>
  /** jun-06 RFC — OPTIONAL `resources/*` + `prompts/*` capability probes +
   *  no-throw methods. `McpClient` exposes all six; `IsolatedMcpClient` (and any
   *  test double that does not speak resources) exposes none, so the supervisor's
   *  `serverSupportsResources`/`serverSupportsPrompts` default to `false` and the
   *  resources surface stays absent (byte-identical default-OFF). Read per call
   *  off the CURRENT live client so a restart re-evaluates capability.
   *
   *  Each method is NO-THROW (returns a typed {@link McpResult}); the supervisor's
   *  `proxyResources` still guards so a non-conforming client can never throw into
   *  the N3 aggregate. */
  serverSupportsResources?(): boolean
  serverSupportsPrompts?(): boolean
  listResources?(): Promise<McpResult<McpResource[]>>
  listResourceTemplates?(): Promise<McpResult<McpResourceTemplate[]>>
  readResource?(uri: string): Promise<McpResult<McpResourceContent[]>>
  listPrompts?(): Promise<McpResult<McpPrompt[]>>
  getPrompt?(name: string, args?: Record<string, unknown>): Promise<McpResult<McpPromptResult>>
}

/** How the supervisor builds a fresh client instance on each restart. Injected
 *  so tests provide a fake double and the CLI selects the legacy vs isolated
 *  client without the supervisor knowing either concrete type. */
export type McpClientFactory = (config: McpServerConfig) => SupervisableMcpClient
