/**
 * ★ TICKET-19 reverse-MCP — `McpServer` inbound JSON-RPC dispatcher.
 *
 * The server is the INVERSE of `McpClient.dispatch`: it only ever services
 * inbound requests + notifications and writes replies back over an injected
 * `write(line)`. Every case is adversarial about the RCE surface:
 *   - `tools/list` returns ONLY whitelisted (read-only) tools; a mutating tool
 *     injected with `readOnly:false` is ABSENT.
 *   - `tools/call` on a NON-whitelisted name is `-32602` AND the `toolCall`
 *     port is invoked ZERO times (proves no bypass of the dispatch fence).
 *   - a throwing `toolCall` maps to `-32603` and the pump SURVIVES.
 *   - pagination cursors round-trip and never loop.
 *   - oversized results are truncated to a LOCAL cap.
 *
 * Pure + injected ports ⇒ no @/agent, no @/tool, no process.
 */

import { describe, expect, test } from "bun:test"
import { SUPPORTED_PROTOCOL_VERSIONS } from "../protocol-version"
import { McpServer } from "../server"
import type { ToolCallPort, ToolListSource } from "../server-builder"

interface Captured {
  lines: string[]
  parsed: () => unknown[]
}

const captureWriter = (): { write: (s: string) => void } & Captured => {
  const lines: string[] = []
  return {
    write: (s: string) => {
      // The pump emits newline-terminated frames; split + keep non-empty.
      for (const part of s.split("\n")) if (part.trim().length > 0) lines.push(part)
    },
    lines,
    parsed: () => lines.map((l) => JSON.parse(l)),
  }
}

const fakeToolList = (): ToolListSource => ({
  specs: () => [
    { name: "read", description: "read a file", input_schema: { type: "object" } },
    { name: "bash", description: "run a shell command", input_schema: { type: "object" } },
  ],
  readOnly: (name) => name === "read",
})

/** Build a server with read-only whitelist + a spyable toolCall. */
const makeServer = (
  toolCall: ToolCallPort,
  writer: { write: (s: string) => void },
  toolList: ToolListSource = fakeToolList(),
): McpServer =>
  new McpServer({
    toolList,
    toolCall,
    write: writer.write,
    readOnlyPolicy: (name) => toolList.readOnly(name),
  })

const req = (id: number, method: string, params?: unknown): string =>
  `${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) })}\n`

const replyFor = (writer: Captured, id: number): Record<string, unknown> => {
  const found = (writer.parsed() as Array<Record<string, unknown>>).find((m) => m.id === id)
  if (found === undefined) throw new Error(`no reply for id ${id}`)
  return found
}

describe("McpServer.initialize", () => {
  test("replies a SUPPORTED protocol version + serverInfo + capabilities", () => {
    const w = captureWriter()
    const spy = createSpy()
    const server = makeServer(spy.port, w)
    server.feed(req(1, "initialize", { protocolVersion: "2025-06-18" }))
    const reply = replyFor(w, 1)
    const result = reply.result as Record<string, unknown>
    expect(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).toContain(
      result.protocolVersion as string,
    )
    expect((result.serverInfo as Record<string, unknown>).name).toBe("quanta")
    expect((result.capabilities as Record<string, unknown>).tools).toBeDefined()
  })

  test("notifications/initialized produces NO reply", () => {
    const w = captureWriter()
    const server = makeServer(createSpy().port, w)
    server.feed(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`)
    expect(w.lines).toHaveLength(0)
  })
})

describe("McpServer.tools/list (whitelist projection)", () => {
  test("returns ONLY read-only tools — injected mutating 'bash' is ABSENT", () => {
    const w = captureWriter()
    const server = makeServer(createSpy().port, w)
    server.feed(req(2, "tools/list"))
    const result = replyFor(w, 2).result as { tools: Array<{ name: string }> }
    const names = result.tools.map((t) => t.name)
    expect(names).toContain("read")
    // red-on-injection: if the whitelist regressed, `bash` would appear here.
    expect(names).not.toContain("bash")
  })

  test("descriptions are prefixed with the read-only marker (UX)", () => {
    const w = captureWriter()
    const server = makeServer(createSpy().port, w)
    server.feed(req(2, "tools/list"))
    const result = replyFor(w, 2).result as {
      tools: Array<{ name: string; description: string }>
    }
    const read = result.tools.find((t) => t.name === "read")
    expect(read?.description).toContain("[quanta · read-only]")
  })

  test("empty whitelist ⇒ { tools: [] }", () => {
    const w = captureWriter()
    const empty: ToolListSource = { specs: () => [], readOnly: () => false }
    const server = makeServer(createSpy().port, w, empty)
    server.feed(req(3, "tools/list"))
    const result = replyFor(w, 3).result as { tools: unknown[] }
    expect(result.tools).toEqual([])
  })

  test("pagination cursor round-trips and never loops", () => {
    // 5 read-only tools, page size forced to 2 ⇒ 3 pages.
    const many: ToolListSource = {
      specs: () =>
        Array.from({ length: 5 }, (_, i) => ({
          name: `r${i}`,
          description: "ro",
          input_schema: { type: "object" },
        })),
      readOnly: () => true,
    }
    const w = captureWriter()
    const server = new McpServer({
      toolList: many,
      toolCall: createSpy().port,
      write: w.write,
      readOnlyPolicy: () => true,
      pageSize: 2,
    })
    const collected: string[] = []
    const seenCursors = new Set<string>()
    let cursor: string | undefined
    let id = 10
    for (let page = 0; page < 10; page += 1) {
      server.feed(req(id, "tools/list", cursor === undefined ? {} : { cursor }))
      const result = replyFor(w, id).result as {
        tools: Array<{ name: string }>
        nextCursor?: string
      }
      for (const t of result.tools) collected.push(t.name)
      id += 1
      if (result.nextCursor === undefined) break
      // Server-minted cursors must be fresh each page — never a repeat (loop guard).
      expect(seenCursors.has(result.nextCursor)).toBe(false)
      seenCursors.add(result.nextCursor)
      cursor = result.nextCursor
    }
    expect(collected).toEqual(["r0", "r1", "r2", "r3", "r4"])
  })

  test("a bogus/looped cursor is rejected with -32602 (never wedges)", () => {
    const w = captureWriter()
    const server = makeServer(createSpy().port, w)
    server.feed(req(4, "tools/list", { cursor: "not-a-real-cursor" }))
    const reply = replyFor(w, 4)
    expect((reply.error as { code: number }).code).toBe(-32602)
  })
})

describe("McpServer.tools/call (dispatch fence)", () => {
  test("NON-whitelisted tool ⇒ -32602 AND toolCall invoked 0 times (no bypass)", async () => {
    const w = captureWriter()
    const spy = createSpy()
    const server = makeServer(spy.port, w)
    server.feed(req(5, "tools/call", { name: "bash", arguments: { command: "rm -rf /" } }))
    await drain()
    const reply = replyFor(w, 5)
    const error = reply.error as { code: number; message: string }
    expect(error.code).toBe(-32602)
    // red-on-injection: the RCE path must never reach the dispatcher.
    expect(spy.calls).toHaveLength(0)
    // UX: the error names WHY + the per-tool opt-in remediation.
    expect(error.message).toContain("not exposed")
    expect(error.message).toContain("QUANTA_MCP_SERVER_EXPOSE")
  })

  test("whitelisted tool ⇒ toolCall once, result folded to text content", async () => {
    const w = captureWriter()
    const spy = createSpy(async () => ({ text: "hello from read", isError: false }))
    const server = makeServer(spy.port, w)
    server.feed(req(6, "tools/call", { name: "read", arguments: { path: "x" } }))
    await drain()
    expect(spy.calls).toEqual([["read", { path: "x" }]])
    const result = replyFor(w, 6).result as {
      content: Array<{ type: string; text: string }>
      isError: boolean
    }
    expect(result.content[0]).toEqual({ type: "text", text: "hello from read" })
    expect(result.isError).toBe(false)
  })

  test("toolCall reporting isError ⇒ result with isError:true (NOT a raw write)", async () => {
    const w = captureWriter()
    const spy = createSpy(async () => ({ text: "permission denied", isError: true }))
    const server = makeServer(spy.port, w)
    server.feed(req(7, "tools/call", { name: "read", arguments: {} }))
    await drain()
    const result = replyFor(w, 7).result as { isError: boolean }
    expect(result.isError).toBe(true)
  })

  test("malformed params (missing name) ⇒ -32602", async () => {
    const w = captureWriter()
    const spy = createSpy()
    const server = makeServer(spy.port, w)
    server.feed(req(8, "tools/call", { arguments: {} }))
    await drain()
    expect((replyFor(w, 8).error as { code: number }).code).toBe(-32602)
    expect(spy.calls).toHaveLength(0)
  })

  test("toolCall THROWS ⇒ -32603 and the pump survives the next request", async () => {
    const w = captureWriter()
    const spy = createSpy(async () => {
      throw new Error("boom")
    })
    const server = makeServer(spy.port, w)
    server.feed(req(9, "tools/call", { name: "read", arguments: {} }))
    await drain()
    expect((replyFor(w, 9).error as { code: number }).code).toBe(-32603)
    // pump survives: a subsequent valid request still gets serviced.
    server.feed(req(11, "tools/list"))
    expect(replyFor(w, 11).result).toBeDefined()
  })

  test("result over MAX_RESULT_CHARS is truncated (local cap)", async () => {
    const big = "z".repeat(2_000_000)
    const w = captureWriter()
    const spy = createSpy(async () => ({ text: big, isError: false }))
    const server = makeServer(spy.port, w)
    server.feed(req(12, "tools/call", { name: "read", arguments: {} }))
    await drain()
    const result = replyFor(w, 12).result as { content: Array<{ text: string }> }
    expect(result.content[0]?.text.length).toBeLessThan(big.length)
  })
})

describe("McpServer routing", () => {
  test("unknown method ⇒ -32601", () => {
    const w = captureWriter()
    const server = makeServer(createSpy().port, w)
    server.feed(req(13, "nonsense/method"))
    expect((replyFor(w, 13).error as { code: number }).code).toBe(-32601)
  })
})

/** Lightweight spy over the injected `ToolCallPort`. */
const createSpy = (
  impl: (
    name: string,
    args: unknown,
  ) => Promise<{ text: string; isError: boolean }> = async () => ({
    text: "ok",
    isError: false,
  }),
): { port: ToolCallPort; calls: Array<[string, unknown]> } => {
  const calls: Array<[string, unknown]> = []
  const port: ToolCallPort = (name, args) => {
    calls.push([name, args])
    return impl(name, args)
  }
  return { port, calls }
}

/** Let queued microtasks settle (the server services tools/call async). */
const drain = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
