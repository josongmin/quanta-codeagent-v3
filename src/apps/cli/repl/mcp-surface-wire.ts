/** Build the `/mcp` slash command's data surface from the live CLI MCP wiring.
 *
 *  The CLI is the only place that sees the raw `McpServerConfig[]`, the
 *  bridged `Tool[]`, and the live `McpClient[]` simultaneously. The slash
 *  command in `apps/cli/mcp-cmd.ts` consumes a STRUCTURAL surface
 *  ({@link McpSurfaceInfo}) — this module is the translator from "live
 *  CLI state" → "snapshot for /mcp" so the slash command stays testable
 *  with plain object fixtures (no live spawn / live config required).
 *
 *  Decisions:
 *    - We do NOT touch the live `McpClient` (its proc/config are private
 *      by design — RFC slice discipline). pid/uptime stay undefined and
 *      the slash renderer skips them gracefully.
 *    - Configured-but-not-bridged servers ⇒ `status: "failed"` (lifecycle
 *      vocabulary). The error message is not available from `loadMcpTools`
 *      today (it logs + skips), so we surface a stable hint instead of an
 *      empty string.
 *    - Tool→server mapping uses the bridged tool's name prefix
 *      (`mcp__<server>__<tool>` — `mcp-bridge.ts` `mcpToolName`). The
 *      sanitizer replaces non-`[A-Za-z0-9_]` chars with `_`, so we compare
 *      against the SANITIZED server name from the config.
 *
 *  Returns `undefined` when no MCP is configured AND no config path is set
 *  ⇒ the REPL omits the surface entirely; `/mcp` then prints "not wired in
 *  this surface" (same fallback as other surface-wired commands).
 */

import type { McpServerConfig } from "@/mcp"
import type { Tool } from "@/tool"
import type { McpServerInfo, McpSurfaceInfo, McpToolInfo } from "../mcp-cmd"

/** Sanitize a config server name the same way `mcpToolName` does (private
 *  helper in `@/agent/mcp-bridge`). Kept in lockstep here so the join below
 *  matches the BRIDGED tool name's `<server>` slot exactly. */
const sanitizeServerKey = (name: string): string => name.replace(/[^A-Za-z0-9_]+/g, "_")

/** Strip an `mcp__<server>__` prefix from a bridged tool name. Returns the
 *  trailing tool name when the prefix matches, else `null`. The pattern is
 *  anchored to the sanitized `<server>` slot. */
const stripPrefix = (toolName: string, sanitizedServer: string): string | null => {
  const prefix = `mcp__${sanitizedServer}__`
  if (!toolName.startsWith(prefix)) return null
  return toolName.slice(prefix.length)
}

/** Project `inputSchema.required` from a Zod-wrapped MCP tool. We don't have
 *  the raw JSON schema after bridging — the original `required` is lost
 *  during the `mcp-bridge.passthroughSchema` step. For now we expose an
 *  empty list; verbose mode just shows the description. A future bridge
 *  change can attach the raw schema as a non-enumerable property. */
const extractRequired = (_tool: Tool): readonly string[] => []

const toolToInfo = (tool: Tool, sanitizedServer: string): McpToolInfo => {
  const rawName = stripPrefix(tool.name, sanitizedServer) ?? tool.name
  return {
    name: rawName,
    description: tool.description,
    required: extractRequired(tool),
  }
}

/** Build one server row from its (canonical) config + the bridged tools.
 *  `bridged` is null when the server has zero bridged tools — i.e. it failed
 *  to start OR successfully advertised zero tools. We can't tell those apart
 *  without poking the live client; `failed` is the conservative report. */
const buildServerInfo = (cfg: McpServerConfig, bridgedTools: readonly Tool[]): McpServerInfo => {
  const sanitized = sanitizeServerKey(cfg.name)
  const myTools = bridgedTools.filter((t) => t.name.startsWith(`mcp__${sanitized}__`))
  const envKeys = cfg.env ? Object.keys(cfg.env) : undefined
  const tools = myTools.map((t) => toolToInfo(t, sanitized))

  if (myTools.length === 0) {
    const failed: McpServerInfo = {
      name: cfg.name,
      status: "failed",
      toolCount: 0,
      tools: [],
      command: cfg.command,
      errorMessage: "no tools advertised (see logs for spawn/listTools error)",
    }
    if (cfg.cwd !== undefined) (failed as { cwd?: string }).cwd = cfg.cwd
    if (envKeys !== undefined && envKeys.length > 0) {
      ;(failed as { envKeys?: readonly string[] }).envKeys = envKeys
    }
    return failed
  }
  const connected: McpServerInfo = {
    name: cfg.name,
    status: "connected",
    toolCount: tools.length,
    tools,
    command: cfg.command,
  }
  if (cfg.cwd !== undefined) (connected as { cwd?: string }).cwd = cfg.cwd
  if (envKeys !== undefined && envKeys.length > 0) {
    ;(connected as { envKeys?: readonly string[] }).envKeys = envKeys
  }
  return connected
}

export interface BuildMcpSurfaceOpts {
  readonly configs: readonly McpServerConfig[]
  readonly bridgedTools: readonly Tool[]
  /** Path resolved from `QUANTA_MCP_CONFIG` (used by `/mcp config`).
   *  Undefined ⇒ `/mcp config` prints a discovery hint instead. */
  readonly configPath?: string | undefined
}

/** Build the `McpSurfaceInfo` plumbed onto `SlashContext.mcp`. Returns
 *  `undefined` when there is NOTHING to show (no configs AND no config
 *  path) so the slash command can short-circuit to "not wired" cleanly. */
export const buildMcpSurfaceInfo = (opts: BuildMcpSurfaceOpts): McpSurfaceInfo | undefined => {
  const { configs, bridgedTools, configPath } = opts
  if (configs.length === 0 && configPath === undefined) return undefined
  const servers = configs.map((cfg) => buildServerInfo(cfg, bridgedTools))
  const surface: McpSurfaceInfo = { servers }
  if (configPath !== undefined) (surface as { configPath?: string }).configPath = configPath
  return surface
}
