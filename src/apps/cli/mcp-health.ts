/**
 * WS-G item 11 (UUX-6-22) — live MCP server-health registry for the lifecycle
 * pill.
 *
 * The MCP pill used to be BOOT-ONCE (bootstrap derived `[mcp: ✓ …]` from the
 * bridged tools exactly once), so a server dying mid-session stayed ✓ forever.
 * This holder is the tiny mutable seam between the two ends:
 *
 *   - WRITERS: the `loadMcpTools` callbacks the CLI wires in
 *     `internal/mcp.ts#buildMcpLoadOpts` — `onServerExit` (mid-session death,
 *     single-client path) and `onServerLoadError` (never came up).
 *   - READER: `repl/surface-compose/turn-sinks.ts#flushLifecyclePills`
 *     re-derives the pill per flush and overlays this registry via
 *     {@link overlayServerHealth}.
 *
 * Names: pill rows are keyed by the SANITIZED server slot of the bridged tool
 * name (`mcp__<sanitized>__<tool>`, see `agent/mcp-bridge.ts#mcpToolName`),
 * while the callbacks report the RAW config name — {@link sanitizeServerKey}
 * is the same lockstep sanitizer `repl/mcp-surface-wire.ts` uses so the two
 * sides join. Chrome-only: this never gates a tool call.
 */

import type { McpPillServer } from "./lifecycle-pills"

/** Sanitize a config server name the same way `mcpToolName` does (kept in
 *  lockstep with `repl/mcp-surface-wire.ts#sanitizeServerKey`). */
const sanitizeServerKey = (name: string): string => name.replace(/[^A-Za-z0-9_]+/g, "_")

export interface McpHealthHolder {
  /** Record `server` (RAW config name) as down. Last reason wins. */
  markDown(server: string, reason?: string): void
  /** Sanitized-name → reason map of every server marked down this session. */
  downServers(): ReadonlyMap<string, string | undefined>
}

export const createMcpHealthHolder = (): McpHealthHolder => {
  const down = new Map<string, string | undefined>()
  return {
    markDown: (server, reason) => {
      down.set(sanitizeServerKey(server), reason)
    },
    downServers: () => down,
  }
}

/** Overlay the down-registry onto a freshly-derived pill server list:
 *  a derived row whose (sanitized) name is in the registry flips to `down`;
 *  a down server that never bridged any tool (load failure) is APPENDED so it
 *  shows up at all. Pure — returns a new array. */
export const overlayServerHealth = (
  servers: readonly McpPillServer[],
  down: ReadonlyMap<string, string | undefined>,
): McpPillServer[] => {
  const out = servers.map((s) =>
    down.has(sanitizeServerKey(s.name)) ? { ...s, status: "down" as const } : s,
  )
  const present = new Set(servers.map((s) => sanitizeServerKey(s.name)))
  for (const name of down.keys()) {
    if (!present.has(name)) out.push({ name, status: "down" })
  }
  return out
}
