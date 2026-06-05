/**
 * N2 — host binding for MCP connector DISCOVERY (backlog §7 / §9).
 *
 * Bridges the PURE `@/connectors` catalog + the `toMcpServerConfig` transform to
 * the real `.mcp.json` writer, producing the duck-typed
 * `McpConnectorDiscoveryPort` that `buildDefaultTools({ mcpConnectors })` exposes
 * as `mcp_connector_list` / `mcp_connector_install`.
 *
 * Layering: `@/tool` may NOT import `@/connectors` / `@/mcp` (fence); the HOST
 * owns both, so this module sits in `@/host/runtime` and feeds the tool a plain
 * port value. The WRITE target is the plugin-style `.mcp.json`
 * (`{ mcpServers: { <name>: { command, args, ... } } }`) — exactly the shape
 * `readMcpConfig` ingests on the next launch, so an install round-trips.
 *
 * Atomicity: the merge is read-modify-write through `writeFileAtomic` (temp +
 * fsync + rename) so a crash can never leave a torn `.mcp.json`. A pre-existing
 * server under the same id is OVERWRITTEN (re-install = update), reported via
 * `alreadyPresent`.
 *
 * Schema note: the plugin `MCPServerSpec` is `.strict()` and carries no `oauth` /
 * `cwd` keys, so those are dropped on write — `url` presence is what opts an http
 * server into the H18 per-server OAuth path (resolved separately at connect
 * time). `command: string[]` is split into the plugin `{ command, args }` pair.
 *
 * DEFAULT-OFF: wired only when `QUANTA_MCP_CONNECTORS=1` (the arg-builder gate);
 * absent ⇒ no port ⇒ tools never registered ⇒ byte-identical.
 */

import {
  BUNDLED_MCP_CONNECTORS,
  createMcpConnectorCatalog,
  type McpConnectorCatalogPort,
  type McpConnectorEntry,
  type McpServerConfigShape,
  toMcpServerConfig,
} from "@/connectors"
import { writeFileAtomic } from "@/storage"
import type { McpConnectorDiscoveryPort, McpConnectorEntryView, McpInstallOutcome } from "@/tool"

/** Plugin-style `.mcp.json` server spec (mirror of `@/skill` `MCPServerSpec`). */
interface PluginMcpServerSpec {
  command: string
  args: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}
interface PluginMcpRoot {
  mcpServers: Record<string, PluginMcpServerSpec>
}

const toView = (e: McpConnectorEntry): McpConnectorEntryView => ({
  id: e.id,
  name: e.name,
  description: e.description,
  transport: e.transport,
  ...(e.requiresOAuth === true ? { requiresOAuth: true } : {}),
})

/** `McpServerConfigShape` (command: string[]) → the plugin `.mcp.json` spec
 *  (command: string + args: string[]). Drops `oauth`/`cwd` — not in the strict
 *  plugin schema. */
const toPluginSpec = (c: McpServerConfigShape): PluginMcpServerSpec => ({
  command: c.command[0] ?? "",
  args: [...c.command.slice(1)],
  ...(c.env !== undefined ? { env: { ...c.env } } : {}),
  ...(c.url !== undefined ? { url: c.url } : {}),
  ...(c.headers !== undefined ? { headers: { ...c.headers } } : {}),
})

/** Read the existing `.mcp.json` and return its `mcpServers` map (empty when the
 *  file is absent / unparseable / wrong-shaped — a fresh map). NO-THROW. */
const readExistingServers = async (
  configPath: string,
): Promise<Record<string, PluginMcpServerSpec>> => {
  try {
    const raw = await Bun.file(configPath).text()
    const parsed = JSON.parse(raw) as Partial<PluginMcpRoot>
    if (parsed.mcpServers !== null && typeof parsed.mcpServers === "object") {
      return { ...(parsed.mcpServers as Record<string, PluginMcpServerSpec>) }
    }
  } catch {
    // absent / unreadable / malformed ⇒ start fresh (never throw)
  }
  return {}
}

/**
 * Build the discovery port the connector tools speak to. `catalog` defaults to
 * the bundled reference set; the host may inject a remote / REST-backed source.
 * `configPath` is the `.mcp.json` install target (the arg-builder resolves it
 * from cwd / `QUANTA_MCP_CONFIG`).
 */
export const buildMcpConnectorDiscoveryPort = (args: {
  readonly configPath: string
  readonly catalog?: McpConnectorCatalogPort
}): McpConnectorDiscoveryPort => {
  const catalog = args.catalog ?? createMcpConnectorCatalog(BUNDLED_MCP_CONNECTORS)
  return {
    list(): readonly McpConnectorEntryView[] {
      return catalog.list().map(toView)
    },
    async install(id: string): Promise<McpInstallOutcome> {
      const entry = catalog.get(id)
      if (entry === undefined) return { ok: false, error: "unknown-id" }
      const result = toMcpServerConfig(entry)
      if (!result.ok) return { ok: false, error: result.error }
      const servers = await readExistingServers(args.configPath)
      const alreadyPresent = Object.hasOwn(servers, result.config.name)
      servers[result.config.name] = toPluginSpec(result.config)
      const root: PluginMcpRoot = { mcpServers: servers }
      await writeFileAtomic(args.configPath, `${JSON.stringify(root, null, 2)}\n`)
      return { ok: true, name: result.config.name, alreadyPresent }
    },
  }
}
