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
 * server under the same id whose spec is BYTE-IDENTICAL to ours is an idempotent
 * re-install (`alreadyPresent`); one whose spec DIFFERS is a `name-conflict` —
 * we FAIL CLOSED rather than silently clobber a user's (possibly audited /
 * trusted) same-name server with the catalog's command. Overwriting a divergent
 * entry would let `mcp_connector_install <bundled-id>` swap out a hand-pinned
 * server the host then SPAWNS, so the divergent case is never auto-written.
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

/** Order-independent structural equality of two server specs (the existing
 *  on-disk entry vs the one we'd write). A canonical JSON with sorted keys is
 *  enough — specs are flat records of strings / string-arrays. Used to keep a
 *  re-install idempotent while treating a DIVERGENT same-name entry as a
 *  conflict (never silently overwritten). */
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value !== null && typeof value === "object") {
    const rec = value as Record<string, unknown>
    return `{${Object.keys(rec)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(rec[k])}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}
const sameSpec = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b)

/**
 * Read the existing `.mcp.json` `mcpServers` map. NO-THROW, three outcomes:
 *  - `{ servers }` — file absent (fresh map) OR a well-formed object map;
 *  - `{ corrupt: true }` — the file EXISTS but is unparseable / wrong-shaped
 *    (`mcpServers` not a plain object, or non-JSON). The caller fails the
 *    install instead of CLOBBERING the whole file with a single-server doc —
 *    a transient half-write or a config with a stray edit must not erase the
 *    user's other servers.
 */
const readExistingServers = async (
  configPath: string,
): Promise<
  { readonly servers: Record<string, PluginMcpServerSpec> } | { readonly corrupt: true }
> => {
  const file = Bun.file(configPath)
  if (!(await file.exists())) return { servers: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(await file.text())
  } catch {
    return { corrupt: true } // present but not JSON ⇒ never clobber
  }
  // The doc must be a plain JSON object. A non-object top level (array, string,
  // number) is wrong-shaped ⇒ refuse rather than clobber.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { corrupt: true }
  }
  const mcpServers = (parsed as { mcpServers?: unknown }).mcpServers
  // Absent `mcpServers` ⇒ a fresh map to merge into (a legitimately empty doc).
  if (mcpServers === undefined) return { servers: {} }
  // Present but not a plain object map (array / null / scalar) would spread to
  // numeric index keys / explode the shape ⇒ refuse rather than corrupt.
  if (mcpServers === null || typeof mcpServers !== "object" || Array.isArray(mcpServers)) {
    return { corrupt: true }
  }
  return { servers: { ...(mcpServers as Record<string, PluginMcpServerSpec>) } }
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
      const read = await readExistingServers(args.configPath)
      if ("corrupt" in read) {
        // Existing `.mcp.json` is present but unparseable/wrong-shaped — refuse
        // rather than overwrite the user's whole config with one server.
        return { ok: false, error: "config-unreadable" }
      }
      const servers = read.servers
      const spec = toPluginSpec(result.config)
      const existing = Object.hasOwn(servers, result.config.name)
        ? servers[result.config.name]
        : undefined
      if (existing !== undefined && !sameSpec(existing, spec)) {
        // A same-name server already exists with a DIFFERENT spec — refuse to
        // clobber it (it may be a user-pinned/audited command the host spawns).
        return { ok: false, error: "name-conflict" }
      }
      const alreadyPresent = existing !== undefined
      servers[result.config.name] = spec
      const root: PluginMcpRoot = { mcpServers: servers }
      await writeFileAtomic(args.configPath, `${JSON.stringify(root, null, 2)}\n`)
      return { ok: true, name: result.config.name, alreadyPresent }
    },
  }
}
