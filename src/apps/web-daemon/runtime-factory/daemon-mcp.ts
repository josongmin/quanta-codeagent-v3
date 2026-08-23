/**
 * `@/apps/web-daemon/runtime-factory/daemon-mcp` — ONE responsibility: compose
 * MCP for the web daemon (P4, jul-11 UUX-4-14).
 *
 * Reads the shared `.mcp.json` assembly (`@/host/mcp-composition` — the SAME
 * one the CLI uses), bridges the servers' tools, keeps the client handles for
 * shutdown, and exposes the LIVE `/mcp` readout accessor over the health
 * holder. Headless posture: no elicitation prompter. NEVER throws — a broken
 * MCP config must not crash daemon boot.
 *
 * Extracted verbatim from `../runtime-factory.ts` (god-module split). The edge
 * is ONE-WAY — the parent imports this file.
 */

import type { McpStoppable } from "@/agent"
import {
  buildMcpLoadOpts,
  loadMcpToolsOrEmpty,
  mcpAutoRestartEnabled,
  readMcpConfig,
  resolveMcpInboundWiring,
  resolveMcpLaunchPolicy,
  resolveMcpOAuthProvider,
} from "@/host/mcp-composition"
import { createMcpHealthHolder, sanitizeServerKey } from "@/host/mcp-health"
import type { LLMPort } from "@/llm"
import { StructuredLogger } from "@/observability"
import { errMessage, logger } from "@/shared"
import type { Tool } from "@/tool"
import type { McpServerRow } from "../readout"

/**
 * P4 (jul-11, UUX-4-14) — compose MCP for the web daemon from the SAME
 * surface-shared assembly the CLI uses (`@/host/mcp-composition`, promoted out
 * of apps/cli). Headless: no elicitation prompter (an inbound elicitation is
 * auto-declined, byte-identical to a piped CLI). NEVER throws — a broken MCP
 * config must not crash daemon boot; on any fault the daemon serves with no MCP
 * tools and an empty health view.
 *
 * Returns the bridged tools (merged into the daemon registry), the client
 * handles (stopped on shutdown), and a LIVE `/mcp` readout accessor: up/down is
 * re-read from the health holder on every call (so a mid-session server death
 * shows ✗), tool counts are load-time.
 */
export const loadDaemonMcp = async (
  env: Record<string, string | undefined>,
  llm: LLMPort,
): Promise<{
  readonly tools: readonly Tool[]
  readonly clients: readonly McpStoppable[]
  readonly mcpAccessor: (() => readonly McpServerRow[]) | undefined
}> => {
  try {
    const slog = new StructuredLogger()
    const configs = await readMcpConfig(slog, env, await resolveMcpLaunchPolicy(slog))
    if (configs.length === 0) return { tools: [], clients: [], mcpAccessor: undefined }
    const mcpHealth = createMcpHealthHolder()
    const loadOpts = buildMcpLoadOpts(slog, {
      autoRestart: mcpAutoRestartEnabled(),
      inboundWiring: resolveMcpInboundWiring(llm, undefined),
      oauthProvider: resolveMcpOAuthProvider(configs),
      opts: {},
      mcpHealth,
    })
    const { tools, clients } = await loadMcpToolsOrEmpty(configs, undefined, loadOpts)
    // Load-time tool count per RAW config server name (bridged names are
    // `mcp__<sanitized>__<tool>` — join by the sanitized key).
    const countBySanitized = new Map<string, number>()
    for (const t of tools) {
      const m = t.name.match(/^mcp__(.+?)__/)
      if (m?.[1] !== undefined) {
        countBySanitized.set(m[1], (countBySanitized.get(m[1]) ?? 0) + 1)
      }
    }
    const names = configs.map((c) => c.name)
    const mcpAccessor = (): readonly McpServerRow[] => {
      const down = mcpHealth.downServers()
      return names.map((name) => {
        const key = sanitizeServerKey(name)
        if (down.has(key)) {
          const reason = down.get(key)
          return reason !== undefined ? { name, status: "down", reason } : { name, status: "down" }
        }
        return { name, status: "up", toolCount: countBySanitized.get(key) ?? 0 }
      })
    }
    return { tools, clients, mcpAccessor }
  } catch (e) {
    logger.warn("web-daemon: MCP load failed", { error: errMessage(e) })
    return { tools: [], clients: [], mcpAccessor: undefined }
  }
}
