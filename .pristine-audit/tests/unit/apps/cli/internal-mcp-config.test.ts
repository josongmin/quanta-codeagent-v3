import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { StructuredLogger } from "@/observability"
import { readMcpConfig, resolveMcpConfigPath } from "../../../../src/apps/cli/internal"

describe("internal MCP config bridge", () => {
  test("resolveMcpConfigPath prefers QUANTA_MCP_CONFIG over browser bridge envs", () => {
    expect(
      resolveMcpConfigPath({
        QUANTA_MCP_CONFIG: "/tmp/quanta.json",
        QUANTA_BROWSER_MCP_CONFIG: "/tmp/browser.mcp.json",
        QUANTA_BROWSER_MCP_PLUGIN_DIR: "/tmp/browser-plugin",
      }),
    ).toBe("/tmp/quanta.json")
  })

  test("resolveMcpConfigPath falls back to QUANTA_BROWSER_MCP_PLUGIN_DIR/.mcp.json", () => {
    expect(
      resolveMcpConfigPath({
        QUANTA_BROWSER_MCP_PLUGIN_DIR: "/tmp/browser-plugin",
      }),
    ).toBe("/tmp/browser-plugin/.mcp.json")
  })

  test("readMcpConfig accepts plugin-style .mcp.json via browser bridge env", async () => {
    const dir = mkdtempSync(join(tmpdir(), "q-mcp-bridge-"))
    const file = join(dir, ".mcp.json")
    try {
      await writeFile(
        file,
        JSON.stringify({
          mcpServers: {
            browser: {
              command: "node",
              args: ["./browser-server.js"],
              env: { BROWSER_MODE: "attached" },
            },
          },
        }),
        "utf8",
      )
      const configs = await readMcpConfig(new StructuredLogger(), {
        QUANTA_BROWSER_MCP_PLUGIN_DIR: dir,
      })
      expect(configs).toEqual([
        {
          name: "browser",
          command: ["node", "./browser-server.js"],
          env: { BROWSER_MODE: "attached" },
        },
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("readMcpConfig still accepts legacy {servers:[...]} wrapper", async () => {
    const dir = mkdtempSync(join(tmpdir(), "q-mcp-legacy-"))
    const file = join(dir, "quanta-mcp.json")
    try {
      await writeFile(
        file,
        JSON.stringify({
          servers: [{ name: "fs", command: ["bun", "fs.ts"] }],
        }),
        "utf8",
      )
      const configs = await readMcpConfig(new StructuredLogger(), {
        QUANTA_MCP_CONFIG: file,
      })
      expect(configs).toEqual([{ name: "fs", command: ["bun", "fs.ts"] }])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  // UUX-4-14 — `/mcp disable` writes `disabled: true` into the SAME file this
  // loader reads; the loader must honor it (SSOT write-through) in BOTH formats.
  test("readMcpConfig drops `disabled: true` servers (plugin format) and keeps the rest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "q-mcp-disabled-"))
    const file = join(dir, ".mcp.json")
    try {
      await writeFile(
        file,
        JSON.stringify({
          mcpServers: {
            off: { command: "node", args: ["off.js"], disabled: true },
            on: { command: "node", args: ["on.js"] },
          },
        }),
        "utf8",
      )
      const configs = await readMcpConfig(new StructuredLogger(), {
        QUANTA_MCP_CONFIG: file,
      })
      expect(configs.map((c) => c.name)).toEqual(["on"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("readMcpConfig drops `disabled: true` servers (legacy format); disabled absent ⇒ kept", async () => {
    const dir = mkdtempSync(join(tmpdir(), "q-mcp-disabled-legacy-"))
    const file = join(dir, "quanta-mcp.json")
    try {
      await writeFile(
        file,
        JSON.stringify({
          servers: [
            { name: "off", command: ["bun", "off.ts"], disabled: true },
            { name: "on", command: ["bun", "on.ts"] },
          ],
        }),
        "utf8",
      )
      const configs = await readMcpConfig(new StructuredLogger(), {
        QUANTA_MCP_CONFIG: file,
      })
      expect(configs.map((c) => c.name)).toEqual(["on"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
