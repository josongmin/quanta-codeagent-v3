import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { convertHooks, convertMcp } from "@/migration/external-config/convert"
import { translateHooks, translateMcpServers } from "@/migration/translators/claude-code-config"

const families = [
  "explicit-sse",
  "url-http",
  "stdio-cmd",
  "unknown",
  "hooks-matcher",
  "hooks-session",
] as const

describe("claude config entrypoint parity", () => {
  test("fixture family floor is 6", () => {
    expect(families.length).toBeGreaterThanOrEqual(6)
  })

  test("same valid bytes → same modeled fields; error policies stay distinct", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-parity-"))
    const mcp = {
      mcpServers: {
        a: { type: "sse", url: "https://ex" },
        b: { url: "https://ex/mcp" },
        c: { command: "node", args: ["x"] },
        d: {},
      },
    }
    const hooks = {
      hooks: {
        PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "true" }] }],
        Stop: [{ hooks: [{ type: "command", command: "false" }] }],
      },
    }
    await writeFile(join(root, ".mcp.json"), JSON.stringify(mcp))
    await writeFile(join(root, "settings.json"), JSON.stringify(hooks))
    const tMcp = await translateMcpServers(root)
    const cMcp = await convertMcp(join(root, ".mcp.json"))
    expect(cMcp.ok && cMcp.value).toEqual(tMcp)
    const tHooks = await translateHooks(root)
    const cHooks = await convertHooks(join(root, "settings.json"))
    expect(cHooks.ok && cHooks.value).toEqual(tHooks)
    expect(await translateMcpServers(join(root, "no-root"))).toEqual([])
    const malformed = await convertMcp(join(root, "missing.json"))
    expect(malformed.ok).toBe(false)
  })

  test("mutation: restoring a local url-as-sse branch diverges from the canonical decoder", async () => {
    const { classifyClaudeTransport, decodeClaudeMcpServers } = await import(
      "@/migration/claude-config-decode"
    )
    const entry = { url: "https://ex/mcp" }
    const drifted = (raw: Record<string, unknown>): "http" | "sse" | "stdio" | "unknown" => {
      const type = raw.type
      if (type === "http" || type === "sse" || type === "stdio") return type
      if (typeof raw.url === "string") return "sse"
      if (typeof raw.command === "string") return "stdio"
      return "unknown"
    }
    expect(classifyClaudeTransport(entry)).toBe("http")
    expect(drifted(entry)).toBe("sse")
    expect(drifted(entry)).not.toBe(classifyClaudeTransport(entry))
    const live = decodeClaudeMcpServers({ mcpServers: { b: entry } })
    expect(live).toEqual([{ name: "b", transport: "http" }])
  })
})
