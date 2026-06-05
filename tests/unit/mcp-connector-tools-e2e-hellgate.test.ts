/**
 * e2e Hellgate — N2 MCP connector tools over a fake discovery port + default-OFF
 * registration. Also proves the real `@/connectors` catalog + `toMcpServerConfig`
 * compose into a discovery port the tools drive (the seam holds end-to-end).
 */

import { describe, expect, test } from "bun:test"
import { createMcpConnectorCatalog, type McpConnectorEntry, toMcpServerConfig } from "@/connectors"
import type {
  McpConnectorDiscoveryPort,
  McpInstallOutcome,
  Tool,
  ToolContext,
  ToolEvent,
} from "@/tool"
import { buildDefaultTools } from "@/tool"
import { mcpConnectorTools } from "@/tool/mcp-connector"

const ctx = (): ToolContext => ({ cwd: "/repo", signal: new AbortController().signal })

const run = async (tool: Tool, input: unknown): Promise<{ ok: boolean; output: string }> => {
  let last = { ok: false, output: "no result" }
  for await (const ev of tool.execute(input as never, ctx()) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") last = { ok: ev.result.ok, output: ev.result.output }
  }
  return last
}

const byName = (tools: Tool[], name: string): Tool => {
  const t = tools.find((x) => x.name === name)
  if (t === undefined) throw new Error(`tool not found: ${name}`)
  return t
}

const ENTRIES: McpConnectorEntry[] = [
  {
    id: "fs",
    name: "Filesystem",
    description: "local fs",
    transport: "stdio",
    command: ["bunx", "mcp-fs"],
  },
  {
    id: "gh",
    name: "GitHub",
    description: "github",
    transport: "http",
    url: "https://mcp.gh",
    requiresOAuth: true,
  },
]

/** A discovery port composed from the REAL catalog + transform (the seam the
 *  host wires) + an in-memory `.mcp.json` write (records installs). */
const realPort = (): McpConnectorDiscoveryPort & { installed: string[] } => {
  const catalog = createMcpConnectorCatalog(ENTRIES)
  const installed: string[] = []
  return {
    installed,
    list() {
      return catalog.list().map((e) => ({
        id: e.id,
        name: e.name,
        description: e.description,
        transport: e.transport,
        ...(e.requiresOAuth !== undefined ? { requiresOAuth: e.requiresOAuth } : {}),
      }))
    },
    install(id: string): McpInstallOutcome {
      const entry = catalog.get(id)
      if (entry === undefined) return { ok: false, error: "unknown-id" }
      const cfg = toMcpServerConfig(entry)
      if (!cfg.ok) return { ok: false, error: cfg.error }
      installed.push(cfg.config.name)
      return { ok: true, name: cfg.config.name }
    },
  }
}

describe("mcp connector tools — list/install over the real catalog+transform", () => {
  test("list discovers catalog entries (transport + oauth flag)", async () => {
    const tools = mcpConnectorTools(realPort())
    const r = await run(byName(tools, "mcp_connector_list"), {})
    expect(r.ok).toBe(true)
    expect(r.output).toContain("fs")
    expect(r.output).toContain("GitHub")
    expect(r.output).toContain("[oauth]")
  })

  test("transport filter", async () => {
    const tools = mcpConnectorTools(realPort())
    const httpOnly = await run(byName(tools, "mcp_connector_list"), { transport: "http" })
    expect(httpOnly.output).toContain("gh")
    expect(httpOnly.output).not.toContain("Filesystem")
  })

  test("install a known id writes the config (real transform); records it", async () => {
    const port = realPort()
    const tools = mcpConnectorTools(port)
    const r = await run(byName(tools, "mcp_connector_install"), { id: "gh" })
    expect(r.ok).toBe(true)
    expect(r.output).toContain("gh")
    expect(port.installed).toEqual(["gh"])
  })

  test("install unknown id ⇒ typed not-found ok:false", async () => {
    const tools = mcpConnectorTools(realPort())
    const r = await run(byName(tools, "mcp_connector_install"), { id: "nope" })
    expect(r.ok).toBe(false)
    expect(r.output.toLowerCase()).toContain("unknown-id")
  })

  test("bad input ⇒ ok:false (no throw)", async () => {
    const tools = mcpConnectorTools(realPort())
    expect((await run(byName(tools, "mcp_connector_install"), {})).ok).toBe(false)
  })
})

describe("mcp connector tools — default-OFF registration", () => {
  test("absent port ⇒ mcp_connector_* NOT in the default menu", () => {
    const off = buildDefaultTools().map((t) => t.name)
    expect(off).not.toContain("mcp_connector_list")
    expect(off).not.toContain("mcp_connector_install")
  })

  test("wired port ⇒ both tools registered", () => {
    const on = buildDefaultTools({ mcpConnectors: realPort() }).map((t) => t.name)
    expect(on).toContain("mcp_connector_list")
    expect(on).toContain("mcp_connector_install")
  })
})
