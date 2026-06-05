/**
 * ★ E2E CONTRACT — N2 MCP connector discovery, host-binding closeout (§9).
 *
 * Proves the LIVE round-trip: `buildMcpConnectorDiscoveryPort` (the host bridge)
 * lists the bundled catalog and INSTALLS a chosen server into a real `.mcp.json`
 * via the atomic merge writer — and that the SAME file then parses back through
 * `MCPRootSchema` (the EXACT schema `readMcpConfig` validates with on the next
 * launch). This pins the seam the tools (`mcp_connector_install`) drive:
 *
 *   list ⇒ bundled entries (id/name/transport views).
 *   install(stdio id) ⇒ `.mcp.json` parses + carries the expected command/args.
 *   re-install ⇒ alreadyPresent=true, entry updated (no duplicate).
 *   install(unknown) ⇒ ok:false unknown-id, file untouched.
 *   merge ⇒ a pre-existing unrelated server is preserved.
 *
 * The reader (`readMcpConfig`) lives behind the CLI slice fence, so we validate
 * against the shared library schema it delegates to (`MCPRootSchema`) — same
 * contract, no cross-slice test import.
 *
 * Determinism: a per-test temp `.mcp.json` (mkdtemp, cleaned in afterEach); no
 * network, no spawn — only the catalog transform + the file write.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildMcpConnectorDiscoveryPort } from "@/host/runtime/mcp-connector-wire"
import { MCPRootSchema } from "@/skill/plugin-manifest"

let dir: string | undefined
const newConfigPath = (): string => {
  dir = mkdtempSync(join(tmpdir(), "quanta-mcp-conn-"))
  return join(dir, ".mcp.json")
}
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

/** Parse a written `.mcp.json` exactly as the launch-time reader would. */
const parseConfig = async (configPath: string): Promise<Record<string, unknown>> => {
  const raw = await Bun.file(configPath).text()
  const parsed = MCPRootSchema.parse(JSON.parse(raw))
  return parsed.mcpServers as unknown as Record<string, unknown>
}

describe("N2 — buildMcpConnectorDiscoveryPort (host-binding closeout)", () => {
  test("A1 — list() yields the bundled reference catalog (deterministic order)", () => {
    const port = buildMcpConnectorDiscoveryPort({ configPath: newConfigPath() })
    const ids = port.list().map((e) => e.id)
    expect(ids).toContain("filesystem")
    expect(ids).toContain("github")
    expect([...ids]).toEqual([...ids].sort())
  })

  test("A2 — install(stdio) writes a .mcp.json that parses via MCPRootSchema", async () => {
    const configPath = newConfigPath()
    const port = buildMcpConnectorDiscoveryPort({ configPath })
    const outcome = await port.install("filesystem")
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.name).toBe("filesystem")
      expect(outcome.alreadyPresent).toBe(false)
    }
    const servers = await parseConfig(configPath)
    const fs = servers.filesystem as { command: string; args: string[] }
    expect(fs).toBeDefined()
    // plugin shape: executable string + args array
    expect(fs.command).toBe("npx")
    expect(fs.args).toContain("@modelcontextprotocol/server-filesystem")
  })

  test("A3 — re-install ⇒ alreadyPresent=true, no duplicate entry", async () => {
    const configPath = newConfigPath()
    const port = buildMcpConnectorDiscoveryPort({ configPath })
    await port.install("memory")
    const second = await port.install("memory")
    expect(second.ok && second.alreadyPresent).toBe(true)
    const servers = await parseConfig(configPath)
    expect(Object.keys(servers).filter((k) => k === "memory")).toHaveLength(1)
  })

  test("B1 — install(unknown id) ⇒ ok:false unknown-id, file untouched", async () => {
    const configPath = newConfigPath()
    const port = buildMcpConnectorDiscoveryPort({ configPath })
    const outcome = await port.install("does-not-exist")
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toBe("unknown-id")
    // no file written
    expect(await Bun.file(configPath).exists()).toBe(false)
  })

  test("C1 — merge preserves a pre-existing unrelated server", async () => {
    const configPath = newConfigPath()
    await Bun.write(
      configPath,
      JSON.stringify({
        mcpServers: { custom: { command: "bun", args: ["server.ts"] } },
      }),
    )
    const port = buildMcpConnectorDiscoveryPort({ configPath })
    await port.install("github")
    const servers = await parseConfig(configPath)
    const names = Object.keys(servers).sort()
    expect(names).toContain("custom")
    expect(names).toContain("github")
  })
})
