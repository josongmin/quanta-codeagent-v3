/**
 * Hellgate — N2 MCP connector catalog core (PURE). Pins `toMcpServerConfig`
 * (catalog entry → `.mcp.json` shape) + `createMcpConnectorCatalog`:
 *  - stdio entry → command config; http entry → url(+oauth) config;
 *  - stdio without command → typed `missing-command`; http without url → `missing-url`;
 *  - `name` = catalog id; oauth set ONLY for an http entry that requires it;
 *  - catalog list is deterministic (by id) + get round-trips.
 */

import { describe, expect, test } from "bun:test"
import { createMcpConnectorCatalog, type McpConnectorEntry, toMcpServerConfig } from "@/connectors"

const stdio = (over: Partial<McpConnectorEntry> = {}): McpConnectorEntry => ({
  id: "fs",
  name: "Filesystem",
  description: "local fs",
  transport: "stdio",
  command: ["bunx", "mcp-fs"],
  ...over,
})

const http = (over: Partial<McpConnectorEntry> = {}): McpConnectorEntry => ({
  id: "gh",
  name: "GitHub",
  description: "github mcp",
  transport: "http",
  url: "https://mcp.github.com",
  ...over,
})

describe("toMcpServerConfig — transform", () => {
  test("stdio entry → command config (name = id, env carried)", () => {
    const r = toMcpServerConfig(stdio({ env: { TOKEN: "x" } }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.config.name).toBe("fs")
    expect(r.config.command).toEqual(["bunx", "mcp-fs"])
    expect(r.config.env).toEqual({ TOKEN: "x" })
    expect(r.config.url).toBeUndefined()
  })

  test("http entry → url config; requiresOAuth → oauth:true; command empty", () => {
    const r = toMcpServerConfig(http({ requiresOAuth: true }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.config.name).toBe("gh")
    expect(r.config.url).toBe("https://mcp.github.com")
    expect(r.config.command).toEqual([])
    expect(r.config.oauth).toBe(true)
  })

  test("http without requiresOAuth ⇒ no oauth key (exactOptional)", () => {
    const r = toMcpServerConfig(http())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect("oauth" in r.config).toBe(false)
  })

  test("stdio without command ⇒ typed missing-command (no throw)", () => {
    expect(toMcpServerConfig({ ...stdio(), command: [] })).toEqual({
      ok: false,
      error: "missing-command",
    })
    const { command: _c, ...noCmd } = stdio()
    expect(toMcpServerConfig(noCmd as McpConnectorEntry)).toEqual({
      ok: false,
      error: "missing-command",
    })
  })

  test("http without url ⇒ typed missing-url (no throw)", () => {
    expect(toMcpServerConfig({ ...http(), url: "" })).toEqual({ ok: false, error: "missing-url" })
  })
})

describe("createMcpConnectorCatalog", () => {
  test("list is deterministic by id; get round-trips; unknown ⇒ undefined", () => {
    const cat = createMcpConnectorCatalog([http(), stdio()]) // gh, fs
    expect(cat.list().map((e) => e.id)).toEqual(["fs", "gh"]) // byteCompare order
    expect(cat.get("fs")?.transport).toBe("stdio")
    expect(cat.get("gh")?.transport).toBe("http")
    expect(cat.get("nope")).toBeUndefined()
  })

  test("empty catalog ⇒ empty list (default-OFF: nothing discoverable)", () => {
    expect(createMcpConnectorCatalog([]).list()).toEqual([])
  })
})
