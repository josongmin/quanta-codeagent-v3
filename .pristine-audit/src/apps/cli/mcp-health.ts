/**
 * WS-G item 11 (UUX-6-22) — CLI lifecycle-pill overlay over the surface-neutral
 * MCP health registry.
 *
 * The holder itself (`McpHealthHolder` / `createMcpHealthHolder` /
 * `sanitizeServerKey`) was promoted to `@/host/mcp-health` (P4, jul-11) so the
 * web daemon shares it; this module re-exports it for the CLI's existing import
 * sites AND keeps the pill-render overlay (`overlayServerHealth`), which is
 * terminal-only (`McpPillServer`-coupled) and therefore stays on the CLI surface.
 */

import { createMcpHealthHolder, type McpHealthHolder, sanitizeServerKey } from "@/host/mcp-health"
import type { McpPillServer } from "./lifecycle-pills"

export { createMcpHealthHolder, type McpHealthHolder, sanitizeServerKey }

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
