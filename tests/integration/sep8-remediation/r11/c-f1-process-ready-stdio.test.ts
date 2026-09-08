/**
 * C-F1.2 — process-ready isolated spawn: stdio MCP fixture with NO unsolicited
 * ready line starts; DXT ready-line control still requires a first line.
 */
import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpClient } from "@/mcp"
import { IsolatedMcpClient } from "@/mcp/isolated-client"
import { IsolatedMcpTransport } from "@/mcp/transports/isolated"
import { createBunSpawner, IsolatedSpawnError } from "@/plugin-isolation"

const BUN = process.execPath

const MCP_NO_READY = `
let buf = ""
const reply = (m) => process.stdout.write(JSON.stringify(m) + "\\n")
process.stdin.on("data", (c) => {
  buf += c
  let nl
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    const msg = JSON.parse(line)
    if (msg.method === "initialize") {
      reply({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "stub" }, capabilities: { tools: {} } } })
    } else if (msg.method === "tools/list") {
      reply({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "ping", description: "", inputSchema: { type: "object" } }] } })
    } else if (msg.method === "tools/call") {
      reply({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "pong" }], isError: false } })
    }
  }
})
`

const DXT_READY = `
process.stdout.write(JSON.stringify({ ready: true }) + "\\n")
${MCP_NO_READY}
`

const writeServer = async (body: string) => {
  const dir = await mkdtemp(join(tmpdir(), "r11-mcp-"))
  const path = join(dir, "server.mjs")
  await writeFile(path, body, "utf8")
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

describe("C-F1 process-ready vs dxt-ready-line", () => {
  test("process-ready isolated transport starts a stdio MCP with NO ready line", async () => {
    const t = await writeServer(MCP_NO_READY)
    try {
      const transport = new IsolatedMcpTransport(
        { name: "noready", command: [BUN, t.path] },
        { readyMode: "process-ready", spawnTimeoutMs: 3000 },
      )
      const client = new McpClient({ name: "noready", command: [BUN, t.path] }, { transport })
      await client.start()
      const tools = await client.listTools()
      expect(tools.map((x) => x.name)).toEqual(["ping"])
      const res = await client.callTool("ping", {})
      expect(res.ok).toBe(true)
      expect(res.content).toBe("pong")
      await client.stop()
    } finally {
      await t.cleanup()
    }
  })

  test("DXT ready-line IsolatedMcpClient still works with a sentinel", async () => {
    const t = await writeServer(DXT_READY)
    try {
      const client = new IsolatedMcpClient(
        { name: "dxt", command: [BUN, t.path] },
        { spawnTimeoutMs: 3000 },
      )
      await client.start()
      const tools = await client.listTools()
      expect(tools.map((x) => x.name)).toEqual(["ping"])
      await client.stop()
    } finally {
      await t.cleanup()
    }
  })

  test("DXT ready-line spawner still times out when child never emits a first line", async () => {
    const t = await writeServer(`setInterval(() => {}, 10000)`)
    try {
      const spawner = createBunSpawner()
      await expect(
        spawner.spawn({
          entry: BUN,
          args: [t.path],
          serviceName: "silent",
          spawnTimeoutMs: 200,
          readyMode: "dxt-ready-line",
        }),
      ).rejects.toBeInstanceOf(IsolatedSpawnError)
    } finally {
      await t.cleanup()
    }
  })

  test("process-ready spawner returns without a first line", async () => {
    const t = await writeServer(`setInterval(() => {}, 10000)`)
    try {
      const spawner = createBunSpawner()
      const handle = await spawner.spawn({
        entry: BUN,
        args: [t.path],
        serviceName: "silent-pr",
        spawnTimeoutMs: 200,
        readyMode: "process-ready",
      })
      expect(handle.pid).toBeGreaterThan(0)
      await handle.kill()
    } finally {
      await t.cleanup()
    }
  })
})
