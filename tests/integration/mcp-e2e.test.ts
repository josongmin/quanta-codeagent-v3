/**
 * MCP e2e — closes the L3 gap for the MCP integration (catalog row 9.1 / ADR-0007).
 *
 * Existing `mcp-client.test.ts` covers the client/JSON-RPC layer in isolation;
 * `mcp-bridge.test.ts` covers the Tool adapter against a stub client. NEITHER
 * exercises the **full runAgent dispatch pipeline** — that's the closure we
 * add here:
 *
 *   ScriptedLLM → tool_use(mcp__mock__alpha) → real ToolRegistry (defaultTools
 *   + bridged MCP tools) → dispatch → MCP client → JSON-RPC over stdio to a
 *   real subprocess → result event → loop continues with the follow-up step
 *   → done(completed).
 *
 * If any link in that chain regresses (result channel, error mapping, name
 * sanitization, concurrency flag), this test fails. Slice isolation is
 * respected: the bridge lives in `@/agent`; the test imports `@/agent`,
 * `@/tool`, `@/mcp` but never crosses `@/tool ↔ @/mcp` directly.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadMcpTools, runAgent } from "@/agent"
import { defaultTools, ToolRegistry } from "@/tool"
import { cfg, ev, RecordingStream, ScriptedLLM, text, toolUse, withTimeout } from "./_harness"

/** Same mock server pattern as `mcp-client.test.ts` — one binary, two tools
 *  (`alpha` joins text blocks, `boom` returns isError). We re-spawn per test
 *  but write the file once. */
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
          { name: "alpha", description: "joins text", inputSchema: { type: "object" } },
          { name: "boom", description: "errors", inputSchema: { type: "object" } },
        ],
      } })
    } else if (msg.method === "tools/call") {
      if (msg.params.name === "boom") {
        reply({ jsonrpc: "2.0", id: msg.id, result: {
          content: [{ type: "text", text: "it failed" }],
          isError: true,
        } })
      } else {
        reply({ jsonrpc: "2.0", id: msg.id, result: {
          content: [
            { type: "text", text: "hello " + (msg.params.arguments.who || "world") },
            { type: "text", text: "line2" },
          ],
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
  dir = await mkdtemp(join(tmpdir(), "mcp-e2e-"))
  serverPath = join(dir, "mock-server.mjs")
  await writeFile(serverPath, MOCK_SERVER)
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("MCP e2e — bridged tools through real runAgent loop", () => {
  test("happy path: scripted LLM calls mcp__mock__alpha, result reaches transcript, loop completes", async () => {
    const { tools: mcpTools, clients } = await loadMcpTools([
      { name: "mock", command: [process.execPath, serverPath] },
    ])
    expect(mcpTools.map((t) => t.name)).toContain("mcp__mock__alpha")

    const llm = new ScriptedLLM([
      ev(toolUse("call-1", "mcp__mock__alpha", { who: "quanta" })),
      ev(text("done")),
    ])
    const stream = new RecordingStream()
    const config = cfg({
      llm,
      registry: new ToolRegistry([...defaultTools, ...mcpTools]),
      stream,
      cwd: dir,
    })

    try {
      const outcome = await withTimeout(runAgent(config), 15_000, "mcp happy-path")
      expect(outcome.reason).toBe("completed")

      const toolResult = stream.events.find(
        (e) => e.type === "tool_result" && e.name === "mcp__mock__alpha",
      )
      expect(toolResult).toBeDefined()
      if (toolResult && toolResult.type === "tool_result") {
        expect(toolResult.ok).toBe(true)
        // Two text blocks are joined with `\n` by the MCP client (see
        // mcp-client.test.ts L105). The preview is the stdout tail so it
        // must contain both fragments.
        expect(toolResult.preview).toContain("hello quanta")
        expect(toolResult.preview).toContain("line2")
      }
      // LLM was called twice: once to emit tool_use, once after tool_result.
      expect(llm.calls).toBe(2)
    } finally {
      for (const c of clients) await c.stop().catch(() => undefined)
    }
  }, 20_000)

  test("isError mapping: MCP tool returns isError → tool_result.ok=false, loop continues to completion", async () => {
    const { tools: mcpTools, clients } = await loadMcpTools([
      { name: "mock", command: [process.execPath, serverPath] },
    ])

    const llm = new ScriptedLLM([
      ev(toolUse("call-2", "mcp__mock__boom", {})),
      ev(text("acknowledged")),
    ])
    const stream = new RecordingStream()
    const config = cfg({
      llm,
      registry: new ToolRegistry([...defaultTools, ...mcpTools]),
      stream,
      cwd: dir,
    })

    try {
      const outcome = await withTimeout(runAgent(config), 15_000, "mcp error-path")
      expect(outcome.reason).toBe("completed")

      const toolResult = stream.events.find(
        (e) => e.type === "tool_result" && e.name === "mcp__mock__boom",
      )
      expect(toolResult).toBeDefined()
      if (toolResult && toolResult.type === "tool_result") {
        // The MCP isError mapping (mcp-bridge.ts:65-66) → ok:false but the
        // loop does NOT abort; it appends the result and the LLM gets a
        // chance to recover or finish. Closing that contract is the point
        // of this test.
        expect(toolResult.ok).toBe(false)
        expect(toolResult.preview).toContain("it failed")
      }
      expect(llm.calls).toBe(2)
    } finally {
      for (const c of clients) await c.stop().catch(() => undefined)
    }
  }, 20_000)

  test("server-failure isolation: one bad server is logged & skipped, agent still runs", async () => {
    // Two configs: one valid, one whose command resolves to nothing. The
    // bridge MUST log and continue, NOT crash. The agent then runs against
    // only the valid server's tools.
    const { tools: mcpTools, clients } = await loadMcpTools([
      { name: "mock", command: [process.execPath, serverPath] },
      { name: "broken", command: ["/definitely/does/not/exist"] },
    ])
    // Both servers tried; only the mock one's tools should be bridged.
    expect(mcpTools.some((t) => t.name === "mcp__mock__alpha")).toBe(true)
    expect(mcpTools.some((t) => t.name.startsWith("mcp__broken__"))).toBe(false)

    const llm = new ScriptedLLM([ev(text("ok"))])
    const config = cfg({
      llm,
      registry: new ToolRegistry([...defaultTools, ...mcpTools]),
      cwd: dir,
    })
    try {
      const outcome = await withTimeout(runAgent(config), 10_000, "mcp partial-load")
      expect(outcome.reason).toBe("completed")
    } finally {
      for (const c of clients) await c.stop().catch(() => undefined)
    }
  }, 15_000)
})
