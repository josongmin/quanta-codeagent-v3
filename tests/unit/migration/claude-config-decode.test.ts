import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  classifyClaudeTransport,
  decodeClaudeHookMap,
  decodeClaudeMcpServers,
} from "@/migration/claude-config-decode"
import { convertHooks, convertMcp } from "@/migration/external-config/convert"
import { translateHooks, translateMcpServers } from "@/migration/translators/claude-code-config"

const mcpDoc = {
  mcpServers: {
    explicit: { type: "sse", url: "https://example.com", command: "npx" },
    urlOnly: { url: "https://example.com/mcp" },
    stdio: { command: "node", args: ["srv.js", 1, "keep"] },
    unknown: { env: { TOKEN: "secret" } },
    dropEnv: { command: "echo", env: { AWS_SECRET: "x" } },
    bad: "not-object",
  },
}

const hookDoc = {
  PreToolUse: [
    {
      matcher: "Bash",
      hooks: [
        { type: "command", command: "echo a" },
        { type: "prompt", command: "ignored" },
      ],
    },
  ],
  SessionStart: [{ hooks: [{ type: "command", command: "echo b" }] }],
}

describe("claude config decode", () => {
  test("explicit type wins; url infers http; command infers stdio; env dropped", () => {
    const rows = decodeClaudeMcpServers(mcpDoc)
    expect(rows.find((r) => r.name === "explicit")?.transport).toBe("sse")
    expect(rows.find((r) => r.name === "urlOnly")?.transport).toBe("http")
    expect(rows.find((r) => r.name === "stdio")?.transport).toBe("stdio")
    expect(rows.find((r) => r.name === "unknown")?.transport).toBe("unknown")
    expect(JSON.stringify(rows)).not.toContain("TOKEN")
    expect(JSON.stringify(rows)).not.toContain("AWS_SECRET")
    expect(rows.find((r) => r.name === "stdio")?.args).toEqual(["srv.js", "keep"])
  })

  test("hooks keep event/matcher/command order; non-command dropped", () => {
    const hooks = decodeClaudeHookMap(hookDoc)
    expect(hooks.map((h) => h.event)).toEqual(["PreToolUse", "SessionStart"])
    expect(hooks[0]?.matcher).toBe("Bash")
    expect(hooks[0]?.commands).toEqual(["echo a"])
  })

  test("classify table", () => {
    expect(classifyClaudeTransport({ type: "http", command: "x" })).toBe("http")
    expect(classifyClaudeTransport({ url: "https://x" })).toBe("http")
    expect(classifyClaudeTransport({ command: "x" })).toBe("stdio")
    expect(classifyClaudeTransport({})).toBe("unknown")
  })
})

describe("claude config entrypoint parity", () => {
  test("valid fixture families >= 6 and both error policies", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-decode-"))
    await writeFile(join(root, ".mcp.json"), JSON.stringify(mcpDoc))
    await writeFile(join(root, "settings.json"), JSON.stringify({ hooks: hookDoc }))
    const translated = await translateMcpServers(root)
    const converted = await convertMcp(join(root, ".mcp.json"))
    expect(converted.ok).toBe(true)
    if (converted.ok) {
      expect(converted.value).toEqual(translated)
    }
    const th = await translateHooks(root)
    const ch = await convertHooks(join(root, "settings.json"))
    expect(ch.ok).toBe(true)
    if (ch.ok) expect(ch.value).toEqual(th)
    expect(translated.length).toBeGreaterThanOrEqual(4)
    expect(th.length).toBeGreaterThanOrEqual(2)
    const missing = await translateMcpServers(join(root, "absent"))
    expect(missing).toEqual([])
    const bad = await convertMcp(join(root, "nope.json"))
    expect(bad.ok).toBe(false)
  })
})
