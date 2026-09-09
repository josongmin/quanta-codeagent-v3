import type { ProxyEnvInput } from "@/runtime/network-proxy"
import { HttpSseMcpTransport } from "../transports/http-sse"
import { IsolatedMcpTransport } from "../transports/isolated"
import type { McpTransport } from "../transports/port"
import { StdioMcpTransport } from "../transports/stdio"
import type { McpServerConfig } from "../types"

/** How to construct the carrier for a `McpClient`. Omitting it (the
 *  default) selects the stdio transport, which is byte-identical to every
 *  pre-ADR-0391 deployment. A function lets callers fully control construction
 *  (e.g. an HTTP transport, or a test double); an explicit `McpTransport`
 *  instance is also accepted. */
export type McpClientTransport = McpTransport | ((config: McpServerConfig) => McpTransport)

/** Build the default transport for a config. Stdio is the default carrier; the
 *  HTTP-SSE carrier is selected only when the config carries a `url` (an
 *  explicit opt-in), preserving stdio byte-identity for every command-based
 *  server. When the host-injected isolated-spawn policy is on, command-based
 *  servers use the isolated process carrier in `process-ready` mode (C-F1).
 *  HTTP is unchanged. */
export const defaultTransportFor = (
  config: McpServerConfig,
  offeredVersion: string,
  proxyEnv?: ProxyEnvInput,
  isolatedSpawn = false,
): McpTransport => {
  if (config.url !== undefined && config.url !== "") {
    return new HttpSseMcpTransport({
      url: config.url,
      name: config.name,
      // Ticket misc-jun-7/01 — stamp the OFFERED protocol version on the header
      // until negotiation pins the server-chosen one (client calls
      // `setProtocolVersion` after `initialize`).
      protocolVersion: offeredVersion,
      ...(config.headers !== undefined ? { headers: config.headers } : {}),
      // §1.2 (ticket-09) — seed the SSE resume cursor so the standalone GET sends
      // `Last-Event-ID` (the supervisor carries it across a restart).
      ...(config.resumeFromEventId !== undefined
        ? { resumeFromEventId: config.resumeFromEventId }
        : {}),
    })
  }
  if (isolatedSpawn) {
    return new IsolatedMcpTransport(config, {
      readyMode: "process-ready",
      ...(proxyEnv !== undefined ? { proxyEnv } : {}),
    })
  }
  return new StdioMcpTransport(config, proxyEnv !== undefined ? { proxyEnv } : {})
}
