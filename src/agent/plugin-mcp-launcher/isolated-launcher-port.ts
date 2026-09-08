/**
 * ADR-0338 — production {@link McpLauncherPort} factory backed by
 * `@/mcp` `McpClient` + `IsolatedMcpTransport` (`dxt-ready-line`).
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
 * Production plugin spawn uses the same `McpClient` protocol core as
 * host/bridge, with an isolated transport in DXT ready-line mode.
 * `MCP_USE_ISOLATED_SPAWN` factory path is `process-ready` and is not
 * used here — plugin/DXT children emit a sentinel first line.
 */

import { IsolatedMcpTransport, type IsolatedMcpTransportOpts, McpClient } from "@/mcp"
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
 *  into {@link IsolatedMcpTransport}; ready mode is always `dxt-ready-line`. */
export interface IsolatedMcpLauncherPortOpts {
  readonly transportOpts?: IsolatedMcpTransportOpts
}

/** Create a production launcher port. The returned port's `launch()`
 *  spawns one `McpClient` + isolated transport per call. Failures are
 *  caught and converted into `ready: false` handles per the NO-THROW
 *  contract.
 *
 *  The returned handle's `shutdown()` calls `McpClient.stop()`, which
 *  is already idempotent. */
export const createIsolatedMcpLauncherPort = (
  opts: IsolatedMcpLauncherPortOpts = {},
): McpLauncherPort => {
  const transportOpts = opts.transportOpts
  return {
    launch: async (
      spec: PluginMcpServerSpec,
      launchOpts: McpLaunchOpts,
    ): Promise<McpServerHandle> => {
      const serverId = composeServerId(launchOpts.pluginId, launchOpts.serverName)
      let client: McpClient | null = null
      try {
        const cfg = toMcpConfig(spec, launchOpts.pluginId, launchOpts.serverName)
        const transport = new IsolatedMcpTransport(cfg, {
          ...(transportOpts ?? {}),
          readyMode: "dxt-ready-line",
        })
        client = new McpClient(cfg, { transport })
        await client.start()
        const startedClient = client
        return {
          serverId,
          ready: true,
          shutdown: async () => {
            try {
              await startedClient.stop()
            } catch {
              // McpClient.stop is idempotent; defense-in-depth.
            }
          },
        }
      } catch (e) {
        if (client !== null) {
          try {
            await client.stop()
          } catch {
            // already in error path
          }
        }
        return {
          serverId,
          ready: false,
          error: errMessage(e),
          shutdown: async () => {},
        }
      }
    },
  }
}
