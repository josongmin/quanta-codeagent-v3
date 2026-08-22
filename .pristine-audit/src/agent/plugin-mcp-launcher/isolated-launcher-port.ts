/**
 * ADR-0338 — production {@link McpLauncherPort} factory backed by
 * `@/mcp` `IsolatedMcpClient`.
 *
 * Default-OFF: nothing in `@/agent/loop` or `@/agent/dispatch` imports
 * this module. A composition root that wants plugin-declared MCP
 * servers to actually spawn must:
 *
 *   ```ts
 *   import { createIsolatedMcpLauncherPort } from "@/agent/plugin-mcp-launcher"
 *   import { createInMemoryPluginMcpRegistry } from "@/agent/plugin-mcp-launcher"
 *   const registry = createInMemoryPluginMcpRegistry()
 *   const port = createIsolatedMcpLauncherPort()
 *   // on plugin activation:
 *   await launchPluginMcpServers(manifest, registry, port)
 *   // on session end:
 *   await registry.shutdownAll()
 *   ```
 *
 * The trigger from a `plugin://name` mention to this call site is
 * deliberately out-of-scope for ADR-0338 (see ADR for justification +
 * the follow-up that wires the mention path).
 *
 * Why isolated and not the legacy `McpClient` (`@/mcp/client`)? The
 * isolated path adds spawn-timeout + SIGTERM grace + service-name
 * sanitiser — all directly useful when launching plugin-supplied
 * processes whose stability is unknown. The legacy client remains
 * available for hosts that already wire it; they can author their own
 * `McpLauncherPort` adapter in O(15 lines) following this template.
 */

import { IsolatedMcpClient, type IsolatedMcpClientOpts } from "@/mcp/isolated-client"
import type { McpServerConfig } from "@/mcp/types"
import { errMessage } from "@/shared"
import type { McpLauncherPort, McpLaunchOpts, McpServerHandle, PluginMcpServerSpec } from "./types"

const composeServerId = (pluginId: string, serverName: string): string =>
  `${pluginId}::${serverName}`

/** Convert the plugin manifest's `MCPServerSpec` (command + args) to the
 *  `@/mcp` `McpServerConfig` (argv joined into `command: string[]`).
 *  Mirrors `pluginSpecToServerConfig` in `src/apps/cli/internal.ts:480`
 *  — kept private to this slice to avoid cross-slice import of CLI
 *  internals. */
const toMcpConfig = (
  spec: PluginMcpServerSpec,
  pluginId: string,
  serverName: string,
): McpServerConfig => {
  const cfg: McpServerConfig = {
    name: composeServerId(pluginId, serverName),
    // command/args are optional (an http server omits them); an absent/empty
    // command yields the empty argv the http carrier selects on.
    command:
      spec.command !== undefined && spec.command.length > 0
        ? [spec.command, ...(spec.args ?? [])]
        : [],
  }
  if (spec.env !== undefined) cfg.env = spec.env
  if (spec.url !== undefined) cfg.url = spec.url
  if (spec.headers !== undefined) cfg.headers = spec.headers
  if (spec.oauth === true) cfg.oauth = true
  return cfg
}

/** Options shared across every launch this port performs. Forwarded
 *  verbatim into {@link IsolatedMcpClient}. */
export interface IsolatedMcpLauncherPortOpts {
  readonly clientOpts?: IsolatedMcpClientOpts
}

/** Create a production launcher port. The returned port's `launch()`
 *  spawns one `IsolatedMcpClient` per call. Failures are caught and
 *  converted into `ready: false` handles per the NO-THROW contract.
 *
 *  The returned handle's `shutdown()` calls `IsolatedMcpClient.stop()`,
 *  which is already idempotent (`if (this.stopped) return`). */
export const createIsolatedMcpLauncherPort = (
  opts: IsolatedMcpLauncherPortOpts = {},
): McpLauncherPort => {
  const clientOpts = opts.clientOpts
  return {
    launch: async (
      spec: PluginMcpServerSpec,
      launchOpts: McpLaunchOpts,
    ): Promise<McpServerHandle> => {
      const serverId = composeServerId(launchOpts.pluginId, launchOpts.serverName)
      let client: IsolatedMcpClient | null = null
      try {
        const cfg = toMcpConfig(spec, launchOpts.pluginId, launchOpts.serverName)
        client =
          clientOpts === undefined
            ? new IsolatedMcpClient(cfg)
            : new IsolatedMcpClient(cfg, clientOpts)
        await client.start()
        const startedClient = client
        return {
          serverId,
          ready: true,
          shutdown: async () => {
            try {
              await startedClient.stop()
            } catch {
              // IsolatedMcpClient.stop already swallows; defense-in-depth.
            }
          },
        }
      } catch (e) {
        // Best-effort cleanup of a partially-started client.
        if (client !== null) {
          const partial = client
          try {
            await partial.stop()
          } catch {
            // Ignore — we're already in the error path.
          }
        }
        return {
          serverId,
          ready: false,
          error: errMessage(e),
          shutdown: async () => {
            // Already stopped above.
          },
        }
      }
    },
  }
}
