/**
 * P4 (jul-11, UUX-6-22 promotion) — surface-neutral MCP server-health registry.
 *
 * The tiny mutable seam a session's MCP composition writes into and a surface
 * chrome/readout reads. Promoted from `apps/cli/mcp-health.ts` to `@/host` so
 * BOTH the CLI (lifecycle pill) and the web daemon (`/mcp` readout) compose MCP
 * health from ONE holder — a step toward moving the whole `internal/mcp.ts`
 * config-read + load-assembly path to a surface-shared layer.
 *
 * Pure data — NO terminal/pill coupling (the McpPillServer-coupled render
 * overlay `overlayServerHealth` stays in `apps/cli/mcp-health.ts`). Writers are
 * the `loadMcpTools` callbacks (`onServerExit` / `onServerLoadError`); readers
 * re-derive their view per flush. Chrome-only: never gates a tool call.
 */

/** Sanitize a config server name the same way `agent/mcp-bridge.ts#mcpToolName`
 *  does (kept in lockstep with `repl/mcp-surface-wire.ts#sanitizeServerKey`),
 *  so a down-mark keyed on the RAW config name joins a pill/readout row keyed
 *  on the sanitized bridged-tool slot. */
export const sanitizeServerKey = (name: string): string => name.replace(/[^A-Za-z0-9_]+/g, "_")

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
