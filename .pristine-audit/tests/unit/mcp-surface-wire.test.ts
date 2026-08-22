/**
 * Unit tests for `buildMcpSurfaceInfo` — the REPL→`/mcp` translator.
 *
 *  Builds a `McpSurfaceInfo` from raw configs + bridged tools, exercising
 *  the failed-server reporting (configured but no bridged tools) and the
 *  successful join (bridged tools strip their `mcp__<server>__` prefix).
 */
import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { McpServerConfig } from "@/mcp"
import type { Tool } from "@/tool"
import { buildMcpSurfaceInfo } from "../../src/apps/cli/repl/mcp-surface-wire"

const fakeTool = (name: string, description = ""): Tool => ({
  name,
  description,
  inputSchema: z.unknown(),
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async *execute() {
    yield { type: "result", result: { ok: true, output: "" } }
  },
})

describe("buildMcpSurfaceInfo", () => {
  test("no configs + no path ⇒ undefined (slash prints not-wired fallback)", () => {
    const out = buildMcpSurfaceInfo({ configs: [], bridgedTools: [] })
    expect(out).toBeUndefined()
  })

  test("configs + zero bridged ⇒ every server reported as 'failed'", () => {
    const configs: McpServerConfig[] = [{ name: "playwright", command: ["bun", "pw.ts"] }]
    const out = buildMcpSurfaceInfo({ configs, bridgedTools: [] })
    expect(out).toBeDefined()
    expect(out?.servers.length).toBe(1)
    const srv = out?.servers[0]
    expect(srv?.name).toBe("playwright")
    expect(srv?.status).toBe("failed")
    expect(srv?.toolCount).toBe(0)
    expect(srv?.errorMessage).toContain("no tools advertised")
  })

  test("bridged tools join by mcp__<server>__ prefix; strip prefix on info", () => {
    const configs: McpServerConfig[] = [{ name: "fs", command: ["bun", "fs.ts"] }]
    const bridged: Tool[] = [
      fakeTool("mcp__fs__read_file", "read file contents"),
      fakeTool("mcp__fs__write_file", "write to file"),
    ]
    const out = buildMcpSurfaceInfo({ configs, bridgedTools: bridged })
    const srv = out?.servers[0]
    expect(srv?.status).toBe("connected")
    expect(srv?.toolCount).toBe(2)
    expect(srv?.tools.map((t) => t.name)).toEqual(["read_file", "write_file"])
  })

  test("mixed: one connected + one failed server in same surface", () => {
    const configs: McpServerConfig[] = [
      { name: "fs", command: ["bun", "fs.ts"] },
      { name: "playwright", command: ["bun", "pw.ts"] },
    ]
    const bridged: Tool[] = [fakeTool("mcp__fs__read_file", "")]
    const out = buildMcpSurfaceInfo({ configs, bridgedTools: bridged })
    expect(out?.servers.map((s) => `${s.name}:${s.status}`)).toEqual([
      "fs:connected",
      "playwright:failed",
    ])
  })

  test("env keys exposed (names only, never values)", () => {
    const configs: McpServerConfig[] = [
      { name: "fs", command: ["bun", "fs.ts"], env: { TOKEN: "secret123" } },
    ]
    const bridged: Tool[] = [fakeTool("mcp__fs__t", "")]
    const out = buildMcpSurfaceInfo({ configs, bridgedTools: bridged })
    const srv = out?.servers[0]
    expect(srv?.envKeys).toEqual(["TOKEN"])
    // Values must never leak into the surface.
    const serialized = JSON.stringify(out)
    expect(serialized).not.toContain("secret123")
  })

  test("configPath passed through verbatim for /mcp config", () => {
    const out = buildMcpSurfaceInfo({
      configs: [],
      bridgedTools: [],
      configPath: "/etc/quanta/mcp.json",
    })
    expect(out?.configPath).toBe("/etc/quanta/mcp.json")
  })
})
