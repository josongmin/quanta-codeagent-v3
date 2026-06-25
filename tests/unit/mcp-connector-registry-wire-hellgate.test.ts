/**
 * ★ HELLGATE — N2 connector discovery WIRE-UP closeout (REPORT-jun26 §3.4/§4.4).
 *
 * Two defects this pins:
 *
 *  (A) WIRING — `createRestConnectorRegistry` (the server-driven catalog Claude's
 *      `search_mcp_registry` mirrors) was BUILT but had ZERO consumers: only the
 *      hardcoded BUNDLED 4-entry list was reachable. The adapter
 *      (`fetchCatalogFromRegistry` / `restRegistrySnapshotToCatalog`) bridges the
 *      `ConnectorRegistryPort` (`Connector` shape) to the installable
 *      `McpConnectorCatalogPort` (`McpConnectorEntry`) the discovery port + tools
 *      consume. RED-ON-INJECTION: a registry seed flows all the way to `list()`
 *      and a real `.mcp.json` install — impossible before the adapter existed.
 *
 *  (B) http install ROUND-TRIP — installing an http connector previously (1)
 *      wrote a malformed `command:""` stdio placeholder and (2) DROPPED the H18
 *      `oauth` opt-in, so the installed server never authenticated (401). The fix
 *      writes the canonical Anthropic http shape (NO `command`/`args`) and carries
 *      `oauth` through. RED-ON-INJECTION: assert the written `.mcp.json` parses via
 *      the EXACT launch-time schema (`MCPRootSchema`), omits `command`, and the
 *      mapped `McpServerConfig` carries `oauth:true` + `url` (what the H18 bearer
 *      resolver gates on). Revert either fix and these go red.
 */

import { describe, expect, test } from "bun:test"
import { afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type Connector,
  type ConnectorRegistryPort,
  createInMemoryConnectorRegistry,
  fetchCatalogFromRegistry,
  type RefreshOutcome,
  restRegistrySnapshotToCatalog,
} from "@/connectors"
import {
  buildMcpConnectorDiscoveryPort,
  buildMcpConnectorDiscoveryPortFromRegistry,
} from "@/host/runtime/mcp-connector-wire"
import { MCPRootSchema, MCPServerSpecSchema } from "@/skill/plugin-manifest"

let dir: string | undefined
const newConfigPath = (): string => {
  dir = mkdtempSync(join(tmpdir(), "quanta-mcp-reg-"))
  return join(dir, ".mcp.json")
}
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

const parseConfig = async (configPath: string): Promise<Record<string, unknown>> => {
  const raw = await Bun.file(configPath).text()
  const parsed = MCPRootSchema.parse(JSON.parse(raw))
  return parsed.mcpServers as unknown as Record<string, unknown>
}

const REGISTRY_SEED: ReadonlyArray<Connector> = [
  { id: "linear", displayName: "Linear", host: "mcp.linear.app", auth: "oauth" },
  { id: "notion", displayName: "Notion", host: "https://mcp.notion.com/sse", auth: "none" },
]

describe("N2 — REST registry → catalog adapter (built-not-wired closeout)", () => {
  test("A1 — adapter maps Connector[] → installable http McpConnectorEntry (oauth-faithful)", async () => {
    const registry = createInMemoryConnectorRegistry(REGISTRY_SEED)
    const catalog = await fetchCatalogFromRegistry(registry)
    const entries = catalog.list()
    const linear = entries.find((e) => e.id === "linear")
    const notion = entries.find((e) => e.id === "notion")
    expect(linear).toBeDefined()
    expect(notion).toBeDefined()
    // A server-published connector is an http MCP endpoint; host → https origin.
    expect(linear?.transport).toBe("http")
    expect(linear?.url).toBe("https://mcp.linear.app/")
    expect(linear?.requiresOAuth).toBe(true)
    // An already-absolute host URL is honored verbatim; auth:none ⇒ no oauth.
    expect(notion?.url).toBe("https://mcp.notion.com/sse")
    expect(notion?.requiresOAuth).toBeUndefined()
  })

  test("A2 — registry seed flows end-to-end through install into a real .mcp.json", async () => {
    const configPath = newConfigPath()
    const registry = createInMemoryConnectorRegistry(REGISTRY_SEED)
    const catalog = await fetchCatalogFromRegistry(registry)
    const port = buildMcpConnectorDiscoveryPort({ configPath, catalog })
    // The remote id is reachable ONLY because the adapter wired the registry.
    const ids = port.list().map((e) => e.id)
    expect(ids).toContain("linear")
    const outcome = await port.install("linear")
    expect(outcome.ok).toBe(true)
    const servers = await parseConfig(configPath)
    expect(servers.linear).toBeDefined()
  })

  test("A3 — buildMcpConnectorDiscoveryPortFromRegistry resolves the registry source", async () => {
    const configPath = newConfigPath()
    const registry = createInMemoryConnectorRegistry(REGISTRY_SEED)
    const { port, source } = await buildMcpConnectorDiscoveryPortFromRegistry({
      configPath,
      registry,
    })
    expect(source).toBe("registry")
    expect(port.list().map((e) => e.id)).toContain("notion")
  })

  test("A4 — FAIL-SOFT: an outage falls back to the bundled catalog (never dead discovery)", async () => {
    const configPath = newConfigPath()
    // A registry whose list() always throws (outage with no cache).
    const outageRegistry: ConnectorRegistryPort = {
      list: async () => {
        throw new Error("registry-unreachable")
      },
      get: async () => undefined,
      refresh: async (): Promise<RefreshOutcome> => "cached-degraded",
    }
    const { port, source } = await buildMcpConnectorDiscoveryPortFromRegistry({
      configPath,
      registry: outageRegistry,
    })
    expect(source).toBe("bundled-fallback")
    // Bundled reference servers are still discoverable despite the outage.
    expect(port.list().map((e) => e.id)).toContain("filesystem")
  })

  test("A5 — an un-URL-able registry row is DROPPED, never poisons the catalog", () => {
    const catalog = restRegistrySnapshotToCatalog([
      { id: "broken", displayName: "Broken", host: "   ", auth: "none" },
      { id: "ok", displayName: "OK", host: "mcp.ok.app", auth: "none" },
    ])
    const ids = catalog.list().map((e) => e.id)
    expect(ids).toEqual(["ok"])
  })
})

describe("§3.4 — http connector install ROUND-TRIP (shape + oauth)", () => {
  test("B1 — http install writes the canonical shape: NO command, url present, parses via MCPRootSchema", async () => {
    const configPath = newConfigPath()
    const catalog = restRegistrySnapshotToCatalog([
      { id: "remote", displayName: "Remote", host: "mcp.example.com", auth: "oauth" },
    ])
    const port = buildMcpConnectorDiscoveryPort({ configPath, catalog })
    const outcome = await port.install("remote")
    expect(outcome.ok).toBe(true)
    const raw = JSON.parse(await Bun.file(configPath).text()) as {
      mcpServers: Record<string, Record<string, unknown>>
    }
    const spec = raw.mcpServers.remote
    // Canonical http shape — a `command:""` stdio placeholder is malformed.
    expect("command" in spec).toBe(false)
    expect("args" in spec).toBe(false)
    expect(spec.url).toBe("https://mcp.example.com/")
    // H18 opt-in carried through (was DROPPED before — server 401).
    expect(spec.oauth).toBe(true)
    // Must still parse via the EXACT launch-time schema.
    await parseConfig(configPath)
  })

  test("B2 — schema now ACCEPTS the canonical http server (no command key)", () => {
    // Pre-fix this hard-failed ("command Required"): the canonical Anthropic http
    // `.mcp.json` server omits command. Now it parses.
    const ok = MCPServerSpecSchema.safeParse({ url: "https://x.example.com/sse", oauth: true })
    expect(ok.success).toBe(true)
    // The refine still rejects a server with NEITHER a command NOR a url.
    const bad = MCPServerSpecSchema.safeParse({ env: { A: "1" } })
    expect(bad.success).toBe(false)
    // A stdio server with empty command and no url is still rejected.
    const emptyStdio = MCPServerSpecSchema.safeParse({ command: "", args: [] })
    expect(emptyStdio.success).toBe(false)
  })
})
