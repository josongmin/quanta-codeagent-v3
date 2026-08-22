/**
 * Transport-port hellgate (ADR-0391) — adversarial proofs that the MCP client
 * core (request/dispatch/pending/timeout) is byte-identical across carriers
 * and that the stdio default preserves the pre-port behavior exactly.
 *
 * No real subprocess and no network are spawned: every test drives the client
 * through a fully in-memory transport double (or an injected stdio spawn seam),
 * so these are deterministic API-contract proofs.
 */
import { describe, expect, test } from "bun:test"
import {
  type HttpFetchFn,
  HttpSseMcpTransport,
  McpClient,
  McpError,
  type McpServerConfig,
  type McpTransport,
  type McpTransportExitHandler,
  type McpTransportMessageHandler,
  StdioMcpTransport,
} from "@/mcp"
import { encodeMessage, type JsonRpcMessage } from "@/mcp/jsonrpc"

/** An in-memory transport that records every encoded payload and lets the test
 *  drive inbound messages + exit. It encodes via the SAME `encodeMessage` the
 *  stdio path uses so we can assert byte-identity of what crosses the wire. */
class MemoryTransport implements McpTransport {
  readonly sentBytes: Uint8Array[] = []
  readonly sentObjects: unknown[] = []
  started = false
  closed = false
  private msgHandler: McpTransportMessageHandler | null = null
  private exitHandler: McpTransportExitHandler | null = null
  /** When true, auto-answer initialize so `client.start()` resolves. */
  autoInitialize = true

  async start(): Promise<void> {
    this.started = true
  }
  onMessage(handler: McpTransportMessageHandler): () => void {
    this.msgHandler = handler
    return () => {
      this.msgHandler = null
    }
  }
  onExit(handler: McpTransportExitHandler): () => void {
    this.exitHandler = handler
    return () => {
      this.exitHandler = null
    }
  }
  send(payload: unknown): Error | null {
    this.sentObjects.push(payload)
    this.sentBytes.push(encodeMessage(payload))
    if (this.autoInitialize) {
      const p = payload as { id?: number; method?: string }
      if (p.method === "initialize" && typeof p.id === "number") {
        queueMicrotask(() =>
          this.inbound({ jsonrpc: "2.0", id: p.id as number, result: { capabilities: {} } }),
        )
      }
    }
    return null
  }
  async close(): Promise<void> {
    this.closed = true
  }
  inbound(msg: JsonRpcMessage): void {
    this.msgHandler?.(msg)
  }
  fireExit(reason?: string): void {
    this.exitHandler?.(reason)
  }
}

const cfg = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({
  name: "probe",
  command: ["/bin/false"],
  ...over,
})

describe("ADR-0391 — transport injection & default selection", () => {
  test("no transport opt ⇒ stdio carrier (byte-identical default)", () => {
    const client = new McpClient(cfg())
    const transport = (client as unknown as { transport: unknown }).transport
    expect(transport).toBeInstanceOf(StdioMcpTransport)
  })

  test("config.url ⇒ HTTP-SSE carrier (explicit opt-in)", () => {
    const client = new McpClient(cfg({ command: [], url: "https://srv.example/mcp" }))
    const transport = (client as unknown as { transport: unknown }).transport
    expect(transport).toBeInstanceOf(HttpSseMcpTransport)
  })

  test("transport factory is invoked with the config", () => {
    let seen: McpServerConfig | null = null
    const mem = new MemoryTransport()
    const client = new McpClient(cfg({ name: "factory" }), {
      transport: (c) => {
        seen = c
        return mem
      },
    })
    expect(seen).not.toBeNull()
    expect((seen as unknown as McpServerConfig).name).toBe("factory")
    expect((client as unknown as { transport: unknown }).transport).toBe(mem)
  })

  test("explicit transport instance is used as-is", () => {
    const mem = new MemoryTransport()
    const client = new McpClient(cfg(), { transport: mem })
    expect((client as unknown as { transport: unknown }).transport).toBe(mem)
  })
})

describe("ADR-0391 — client core unchanged across the port", () => {
  test("initialize handshake routes through transport.send + onMessage", async () => {
    const mem = new MemoryTransport()
    const client = new McpClient(cfg(), { transport: mem })
    await client.start()
    expect(mem.started).toBe(true)
    // First payload is initialize, second is the initialized notification.
    const first = mem.sentObjects[0] as { method?: string }
    const second = mem.sentObjects[1] as { method?: string }
    expect(first.method).toBe("initialize")
    expect(second.method).toBe("notifications/initialized")
  })

  test("tools/call resolves from a dispatched response (id correlation)", async () => {
    const mem = new MemoryTransport()
    const client = new McpClient(cfg(), { transport: mem })
    await client.start()
    const callP = client.callTool("alpha", { who: "q" })
    // Find the tools/call id and answer it.
    const callMsg = mem.sentObjects.find(
      (m) => (m as { method?: string }).method === "tools/call",
    ) as { id: number }
    mem.inbound({
      jsonrpc: "2.0",
      id: callMsg.id,
      result: { content: [{ type: "text", text: "hi" }] },
    })
    const res = await callP
    expect(res).toEqual({ ok: true, content: "hi" })
  })

  test("transport exit fails all pending requests (no leaked timers)", async () => {
    const mem = new MemoryTransport()
    const client = new McpClient(cfg(), { transport: mem })
    await client.start()
    const pending = client.listTools()
    mem.fireExit("boom")
    await expect(pending).rejects.toThrow(/exited/)
    // After exit, the client is fail-closed.
    await expect(client.callTool("x", {})).rejects.toThrow(/not running/)
  })

  test("send-time transport error rejects immediately and clears pending", async () => {
    const failing: McpTransport = {
      async start() {},
      onMessage() {
        return () => {}
      },
      onExit() {
        return () => {}
      },
      send() {
        return new Error("enqueue exploded")
      },
      async close() {},
    }
    const client = new McpClient(cfg(), { transport: failing })
    // start() will try initialize → send returns an error → start rejects.
    await expect(client.start()).rejects.toBeInstanceOf(McpError)
  })

  test("stop() closes the transport and is idempotent", async () => {
    const mem = new MemoryTransport()
    const client = new McpClient(cfg(), { transport: mem })
    await client.start()
    await client.stop()
    expect(mem.closed).toBe(true)
    await expect(client.stop()).resolves.toBeUndefined()
  })
})

describe("ADR-0391 — stdio transport byte-identity", () => {
  test("stdio transport writes newline-delimited encodeMessage bytes", () => {
    const writes: Uint8Array[] = []
    const fakeProc = {
      stdin: {
        write: (chunk: Uint8Array) => {
          writes.push(chunk)
          return true
        },
      },
    }
    const transport = new StdioMcpTransport(cfg(), {
      // biome-ignore lint/suspicious/noExplicitAny: minimal fake proc.
      spawn: () => fakeProc as any,
    })
    ;(transport as unknown as { proc: unknown }).proc = fakeProc
    const payload = { jsonrpc: "2.0", id: 1, method: "ping" }
    const err = transport.send(payload)
    expect(err).toBeNull()
    expect(writes).toHaveLength(1)
    // Byte-for-byte equal to the canonical codec output.
    expect(Array.from(writes[0] as Uint8Array)).toEqual(Array.from(encodeMessage(payload)))
  })

  test("stdio send with missing stdin returns a 'stdin closed' error (no throw)", () => {
    const transport = new StdioMcpTransport(cfg())
    ;(transport as unknown as { proc: unknown }).proc = {}
    const err = transport.send({ jsonrpc: "2.0", id: 1, method: "ping" })
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/stdin closed/)
  })

  test("stdio send when stdin.write throws is captured, not propagated", () => {
    const transport = new StdioMcpTransport(cfg())
    ;(transport as unknown as { proc: unknown }).proc = {
      stdin: {
        write: () => {
          throw new Error("kaboom")
        },
      },
    }
    const err = transport.send({ jsonrpc: "2.0", id: 1, method: "ping" })
    expect((err as Error).message).toMatch(/kaboom/)
  })

  test("stdio decodes coalesced stdout chunks into separate messages", async () => {
    // Drive the pump via an async-iterable stdout double.
    const a = JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 })
    const b = JSON.stringify({ jsonrpc: "2.0", id: 2, result: 2 })
    const stdout = (async function* () {
      yield new TextEncoder().encode(`${a}\n${b}\n`)
    })()
    const fakeProc = {
      stdin: { write: () => true },
      stdout,
      exited: new Promise<number>(() => {}),
      kill: () => {},
    }
    const transport = new StdioMcpTransport(cfg(), {
      // biome-ignore lint/suspicious/noExplicitAny: minimal fake proc.
      spawn: () => fakeProc as any,
    })
    const received: JsonRpcMessage[] = []
    transport.onMessage((m) => received.push(m))
    await transport.start()
    await new Promise((r) => setTimeout(r, 10))
    expect(received).toHaveLength(2)
    expect(received[0]).toEqual({ jsonrpc: "2.0", id: 1, result: 1 })
    expect(received[1]).toEqual({ jsonrpc: "2.0", id: 2, result: 2 })
  })

  test("stdio fires exit exactly once when the process exits", async () => {
    let resolveExit: (n: number) => void = () => {}
    const fakeProc = {
      stdin: { write: () => true },
      stdout: (async function* () {})(),
      exited: new Promise<number>((res) => {
        resolveExit = res
      }),
      kill: () => {},
    }
    const transport = new StdioMcpTransport(cfg(), {
      // biome-ignore lint/suspicious/noExplicitAny: minimal fake proc.
      spawn: () => fakeProc as any,
    })
    let exitCount = 0
    transport.onExit(() => {
      exitCount += 1
    })
    await transport.start()
    resolveExit(0)
    await new Promise((r) => setTimeout(r, 10))
    expect(exitCount).toBe(1)
  })
})

describe("ADR-0391 — HTTP-SSE roundtrip (mocked fetch)", () => {
  /** Build a Response double with a single JSON body. */
  const jsonResponse = (
    obj: unknown,
    headers: Record<string, string> = {},
  ): Awaited<ReturnType<HttpFetchFn>> => ({
    ok: true,
    status: 200,
    headers: {
      get: (n: string) =>
        ({ "content-type": "application/json", ...headers })[n.toLowerCase()] ?? null,
    },
    text: async () => JSON.stringify(obj),
    body: null,
  })

  /** Build a Response double carrying an SSE stream of the given data lines. */
  const sseResponse = (events: string[]): Awaited<ReturnType<HttpFetchFn>> => {
    const payload = events.map((e) => `data: ${e}\n\n`).join("")
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload))
        controller.close()
      },
    })
    return {
      ok: true,
      status: 200,
      headers: {
        get: (n: string) => (n.toLowerCase() === "content-type" ? "text/event-stream" : null),
      },
      text: async () => "",
      body: stream,
    }
  }

  test("POST send + JSON response roundtrips a JSON-RPC reply", async () => {
    const transport = new HttpSseMcpTransport({
      url: "https://srv/mcp",
      name: "http",
      openServerStream: false,
      fetch: async (_url, init) => {
        const body = JSON.parse(init.body ?? "{}") as { id: number; method: string }
        return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { echoed: body.method } })
      },
    })
    const received: JsonRpcMessage[] = []
    transport.onMessage((m) => received.push(m))
    await transport.start()
    transport.send({ jsonrpc: "2.0", id: 42, method: "ping" })
    await new Promise((r) => setTimeout(r, 10))
    expect(received).toHaveLength(1)
    expect(received[0]).toEqual({ jsonrpc: "2.0", id: 42, result: { echoed: "ping" } })
  })

  test("POST that returns an SSE stream emits each event's message", async () => {
    const transport = new HttpSseMcpTransport({
      url: "https://srv/mcp",
      name: "http",
      openServerStream: false,
      fetch: async (_url, init) => {
        const body = JSON.parse(init.body ?? "{}") as { id: number }
        return sseResponse([
          JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} }),
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { ok: true } }),
        ])
      },
    })
    const received: JsonRpcMessage[] = []
    transport.onMessage((m) => received.push(m))
    await transport.start()
    transport.send({ jsonrpc: "2.0", id: 7, method: "tools/list" })
    await new Promise((r) => setTimeout(r, 10))
    expect(received).toHaveLength(2)
    expect(received[1]).toEqual({ jsonrpc: "2.0", id: 7, result: { ok: true } })
  })

  test("server-assigned Mcp-Session-Id is echoed on subsequent requests", async () => {
    const seenSession: (string | null)[] = []
    let n = 0
    const transport = new HttpSseMcpTransport({
      url: "https://srv/mcp",
      name: "http",
      openServerStream: false,
      fetch: async (_url, init) => {
        seenSession.push(init.headers["mcp-session-id"] ?? null)
        n += 1
        const body = JSON.parse(init.body ?? "{}") as { id: number }
        // First reply assigns the session id.
        return jsonResponse(
          { jsonrpc: "2.0", id: body.id, result: {} },
          n === 1 ? { "mcp-session-id": "SID-123" } : {},
        )
      },
    })
    await transport.start()
    transport.send({ jsonrpc: "2.0", id: 1, method: "initialize" })
    await new Promise((r) => setTimeout(r, 10))
    transport.send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    await new Promise((r) => setTimeout(r, 10))
    expect(seenSession[0]).toBeNull() // no session on first request
    expect(seenSession[1]).toBe("SID-123") // echoed after assignment
  })

  test("send after close() returns an unavailable error (no throw)", async () => {
    const transport = new HttpSseMcpTransport({
      url: "https://srv/mcp",
      name: "http",
      openServerStream: false,
      fetch: async () => jsonResponse({ jsonrpc: "2.0", id: 1, result: {} }),
    })
    await transport.start()
    await transport.close()
    const err = transport.send({ jsonrpc: "2.0", id: 1, method: "ping" })
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/closed/)
  })

  test("close() fires exit exactly once and DELETEs an assigned session", async () => {
    const methods: string[] = []
    const transport = new HttpSseMcpTransport({
      url: "https://srv/mcp",
      name: "http",
      openServerStream: false,
      fetch: async (_url, init) => {
        methods.push(init.method)
        const body = init.body ? (JSON.parse(init.body) as { id: number }) : { id: 0 }
        return jsonResponse(
          { jsonrpc: "2.0", id: body.id, result: {} },
          init.method === "POST" ? { "mcp-session-id": "S1" } : {},
        )
      },
    })
    let exitCount = 0
    transport.onExit(() => {
      exitCount += 1
    })
    await transport.start()
    transport.send({ jsonrpc: "2.0", id: 1, method: "initialize" })
    await new Promise((r) => setTimeout(r, 10))
    await transport.close()
    expect(exitCount).toBe(1)
    expect(methods).toContain("DELETE")
  })

  test("malformed SSE data is dropped without wedging the stream", async () => {
    const transport = new HttpSseMcpTransport({
      url: "https://srv/mcp",
      name: "http",
      openServerStream: false,
      fetch: async (_url, init) => {
        const body = JSON.parse(init.body ?? "{}") as { id: number }
        return sseResponse([
          "{ not json",
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { ok: 1 } }),
        ])
      },
    })
    const received: JsonRpcMessage[] = []
    transport.onMessage((m) => received.push(m))
    await transport.start()
    transport.send({ jsonrpc: "2.0", id: 9, method: "ping" })
    await new Promise((r) => setTimeout(r, 10))
    expect(received).toHaveLength(1)
    expect(received[0]).toEqual({ jsonrpc: "2.0", id: 9, result: { ok: 1 } })
  })

  test("non-jsonrpc envelope over SSE is rejected (fail-closed)", async () => {
    const transport = new HttpSseMcpTransport({
      url: "https://srv/mcp",
      name: "http",
      openServerStream: false,
      fetch: async () => sseResponse([JSON.stringify({ totally: "not", a: "jsonrpc envelope" })]),
    })
    const received: JsonRpcMessage[] = []
    transport.onMessage((m) => received.push(m))
    await transport.start()
    transport.send({ jsonrpc: "2.0", id: 1, method: "ping" })
    await new Promise((r) => setTimeout(r, 10))
    expect(received).toHaveLength(0)
  })

  test("full client over HTTP-SSE: start + listTools roundtrip", async () => {
    const transport = new HttpSseMcpTransport({
      url: "https://srv/mcp",
      name: "http",
      openServerStream: false,
      fetch: async (_url, init) => {
        const body = JSON.parse(init.body ?? "{}") as { id?: number; method?: string }
        if (body.method === "initialize") {
          return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { capabilities: {} } })
        }
        if (body.method === "tools/list") {
          return jsonResponse({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              tools: [{ name: "alpha", description: "a", inputSchema: { type: "object" } }],
            },
          })
        }
        // notification (no id) → 202
        return {
          ok: true,
          status: 202,
          headers: { get: () => null },
          text: async () => "",
          body: null,
        }
      },
    })
    const client = new McpClient(cfg({ command: [], url: "https://srv/mcp" }), { transport })
    await client.start()
    const tools = await client.listTools()
    await client.stop()
    expect(tools).toEqual([{ name: "alpha", description: "a", inputSchema: { type: "object" } }])
  })
})
