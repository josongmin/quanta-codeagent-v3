import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadMcpTools, mcpToolName } from "@/agent"
import type { ToolContext, ToolEvent } from "@/tool"

/** Tiny MCP server (newline-delimited JSON-RPC 2.0 over stdio): initialize,
 *  tools/list, tools/call (success + isError). Mirrors mcp-client.test.ts. */
const MOCK_SERVER = `
const reply = (m) => process.stdout.write(JSON.stringify(m) + "\\n")
let buf = ""
process.stdin.on("data", (c) => {
  buf += c
  let nl
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    const msg = JSON.parse(line)
    if (msg.method === "initialize") {
      reply({ jsonrpc: "2.0", id: msg.id, result: {
        protocolVersion: "2025-06-18",
        serverInfo: { name: "mock", version: "0.0.1" },
        capabilities: { tools: {} },
      } })
    } else if (msg.method === "notifications/initialized") {
      // notification: no reply
    } else if (msg.method === "tools/list") {
      reply({ jsonrpc: "2.0", id: msg.id, result: {
        tools: [
          { name: "echo", description: "echoes who", inputSchema: {
            type: "object", properties: { who: { type: "string" } }, required: ["who"],
          } },
          { name: "boom", description: "always fails", inputSchema: { type: "object" } },
        ],
      } })
    } else if (msg.method === "tools/call") {
      if (msg.params.name === "boom") {
        reply({ jsonrpc: "2.0", id: msg.id, result: {
          content: [{ type: "text", text: "it failed" }], isError: true,
        } })
      } else {
        reply({ jsonrpc: "2.0", id: msg.id, result: {
          content: [{ type: "text", text: "hello " + (msg.params.arguments.who || "world") }],
        } })
      }
    } else {
      reply({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } })
    }
  }
})
`

let dir: string
let serverPath: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "mcp-bridge-"))
  serverPath = join(dir, "mock-server.mjs")
  await writeFile(serverPath, MOCK_SERVER)
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

const ctx: ToolContext = { cwd: process.cwd(), signal: new AbortController().signal }

const drain = async (it: AsyncIterable<ToolEvent>): Promise<ToolEvent[]> => {
  const out: ToolEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

describe("loadMcpTools bridge", () => {
  it("bridges MCP tools and calls through (success + isError), then stops", async () => {
    const { tools, clients } = await loadMcpTools([
      { name: "mock", command: [process.execPath, serverPath] },
    ])

    expect(tools.map((t) => t.name).sort()).toEqual(
      [mcpToolName("mock", "echo"), mcpToolName("mock", "boom")].sort(),
    )
    const echo = tools.find((t) => t.name === mcpToolName("mock", "echo"))
    expect(echo).toBeDefined()
    if (!echo) throw new Error("missing echo tool")
    expect(echo.isReadOnly()).toBe(false)
    expect(echo.isConcurrencySafe({})).toBe(false)
    // required key enforced by the passthrough schema
    expect(echo.inputSchema.safeParse({}).success).toBe(false)
    expect(echo.inputSchema.safeParse({ who: "quanta" }).success).toBe(true)

    const okEvents = await drain(echo.execute({ who: "quanta" }, ctx))
    expect(okEvents[0]).toEqual({ type: "progress", message: "calling mock tool echo" })
    const okResult = okEvents.at(-1)
    expect(okResult).toEqual({ type: "result", result: { ok: true, output: "hello quanta" } })

    const boom = tools.find((t) => t.name === mcpToolName("mock", "boom"))
    if (!boom) throw new Error("missing boom tool")
    const errEvents = await drain(boom.execute({}, ctx))
    expect(errEvents.at(-1)).toEqual({
      type: "result",
      result: { ok: false, output: "it failed" },
    })

    for (const c of clients) await c.stop()
    // calling after stop yields an error result, never throws out of the loop
    const afterStop = await drain(echo.execute({ who: "x" }, ctx))
    const last = afterStop.at(-1)
    expect(last?.type).toBe("result")
    if (last?.type === "result") expect(last.result.ok).toBe(false)
  })

  it("a failing server is skipped, others still load, never crashes", async () => {
    const { tools, clients } = await loadMcpTools([
      { name: "broken", command: [process.execPath, "/no/such/path-xyz.mjs"] },
      { name: "mock", command: [process.execPath, serverPath] },
    ])
    expect(tools.some((t) => t.name === mcpToolName("mock", "echo"))).toBe(true)
    expect(tools.some((t) => t.name.startsWith("mcp__broken__"))).toBe(false)
    for (const c of clients) await c.stop()
  })
})
