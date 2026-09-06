/**
 * HTTP-SSE pump-death hellgate (jun-10 silent-failure audit, findings #4 + #11).
 *
 * The Streamable-HTTP transport's server→client channel (the standalone GET
 * SSE pump) used to die SILENTLY: a mid-stream error only `logger.debug`'d and
 * `fireExit` only ever ran from `close()`, so the reconnect supervisor stayed
 * "healthy" over a permanently dead channel and the §1.2 Last-Event-ID resume
 * machinery was unreachable. The clean-end sibling (the stream ENDS without
 * throwing while the transport is supposed to live) had no catch at all, and a
 * network blip on the GET handshake (#11) was conflated with a deliberate
 * close()-abort at debug.
 *
 * These tests inject (a) a throwing stream mid-pump, (b) an early-clean-end
 * stream, and (c) a rejecting GET handshake, and assert the REAL observable
 * contract: the transport fires exit (so the ADR-0435 supervisor observes the
 * death via `client.onExit` and can restart with `resumeFromEventId`) and
 * pending requests reject PROMPTLY (not via the 30s per-request timeout).
 * Paired controls prove a DELIBERATE close() still exits exactly once with the
 * quiet "closed" reason — teardown must never masquerade as a crash.
 *
 * No network: every test drives the transport through an injected fetch double.
 */
import { describe, expect, test } from "bun:test"
import {
  type HttpFetchFn,
  type HttpFetchResponse,
  HttpSseMcpTransport,
  McpClient,
  type McpServerConfig,
} from "@/mcp"
import type { JsonRpcMessage } from "@/mcp/jsonrpc"

const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms))

const enc = new TextEncoder()

/** Response double carrying a MANUALLY driven SSE stream: the test pushes
 *  events, then either errors the stream (throwing pump) or closes it
 *  (early-clean-end pump) — the two injection arms of finding #4. */
const manualSseResponse = (): {
  res: HttpFetchResponse
  push: (text: string) => void
  fail: (e: Error) => void
  end: () => void
} => {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })
  return {
    res: {
      ok: true,
      status: 200,
      headers: {
        get: (n: string) => (n.toLowerCase() === "content-type" ? "text/event-stream" : null),
      },
      text: async () => "",
      body: stream,
    },
    push: (text: string) => controller.enqueue(enc.encode(text)),
    fail: (e: Error) => controller.error(e),
    end: () => controller.close(),
  }
}

const jsonResponse = (obj: unknown): HttpFetchResponse => ({
  ok: true,
  status: 200,
  headers: {
    get: (n: string) => (n.toLowerCase() === "content-type" ? "application/json" : null),
  },
  text: async () => JSON.stringify(obj),
  body: null,
})

const accepted202 = (): HttpFetchResponse => ({
  ok: true,
  status: 202,
  headers: { get: () => null },
  text: async () => "",
  body: null,
})

const cfg = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({
  name: "pump-probe",
  command: [],
  url: "https://srv.example/mcp",
  ...over,
})

describe("finding #4 — standalone SSE pump death fires exit (transport level)", () => {
  test("throwing stream mid-pump → exit fires with a death reason, not silence", async () => {
    const sse = manualSseResponse()
    const transport = new HttpSseMcpTransport({
      url: "https://srv.example/mcp",
      name: "pump-probe",
      fetch: async (_url, init) => (init.method === "GET" ? sse.res : accepted202()),
    })
    const received: JsonRpcMessage[] = []
    transport.onMessage((m) => received.push(m))
    const exits: (string | undefined)[] = []
    transport.onExit((reason) => exits.push(reason))

    await transport.start()
    await tick()
    // Prove the pump is LIVE before the injection (paired control: the death
    // assertion below cannot pass vacuously on a never-opened channel).
    sse.push(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "ping/up" })}\n\n`)
    await tick()
    expect(received).toHaveLength(1)
    expect(exits).toHaveLength(0) // healthy pump ⇒ no exit yet

    sse.fail(new Error("connection reset by peer"))
    await tick()
    expect(exits).toHaveLength(1)
    expect(exits[0]).toMatch(/standalone SSE stream died/)
    expect(exits[0]).toMatch(/connection reset by peer/)
  })

  test("early-CLEAN-end stream (no throw) while alive → exit fires all the same", async () => {
    const sse = manualSseResponse()
    const transport = new HttpSseMcpTransport({
      url: "https://srv.example/mcp",
      name: "pump-probe",
      fetch: async (_url, init) => (init.method === "GET" ? sse.res : accepted202()),
    })
    const exits: (string | undefined)[] = []
    transport.onExit((reason) => exits.push(reason))

    await transport.start()
    await tick()
    expect(exits).toHaveLength(0)

    sse.end() // server closes the channel cleanly — the un-ratchetable sibling
    await tick()
    expect(exits).toHaveLength(1)
    expect(exits[0]).toMatch(/standalone SSE stream died/)
  })

  test("paired control — deliberate close() exits exactly once with the quiet reason", async () => {
    const sse = manualSseResponse()
    const transport = new HttpSseMcpTransport({
      url: "https://srv.example/mcp",
      name: "pump-probe",
      fetch: async (_url, init) => (init.method === "GET" ? sse.res : accepted202()),
    })
    const exits: (string | undefined)[] = []
    transport.onExit((reason) => exits.push(reason))

    await transport.start()
    await tick()
    await transport.close()
    await tick()
    expect(exits).toHaveLength(1)
    expect(exits[0]).toMatch(/closed/)
    expect(exits[0]).not.toMatch(/died|failed/)
  })
})

describe("finding #4 — pending requests reject PROMPTLY through the client (supervisor seam)", () => {
  /** Full client over the transport: initialize answers via JSON POST, the
   *  awaited tools/list reply NEVER arrives (hanging POST SSE body), so only
   *  the transport-exit fan-out can settle it before the 30s timeout. */
  const buildClient = (
    standalone: ReturnType<typeof manualSseResponse>,
  ): { client: McpClient; clientExits: (string | undefined)[] } => {
    const hangingPost = manualSseResponse() // never delivers, never ends
    const fetchFn: HttpFetchFn = async (_url, init) => {
      if (init.method === "GET") return standalone.res
      if (init.method === "DELETE") return accepted202()
      const body = JSON.parse(init.body ?? "{}") as { id?: number; method?: string }
      if (body.method === "initialize") {
        return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { capabilities: {} } })
      }
      if (body.id === undefined) return accepted202() // notifications
      return hangingPost.res // tools/list: reply never arrives
    }
    const transport = new HttpSseMcpTransport({
      url: "https://srv.example/mcp",
      name: "pump-probe",
      fetch: fetchFn,
    })
    const client = new McpClient(cfg(), { transport })
    const clientExits: (string | undefined)[] = []
    client.onExit((reason) => clientExits.push(reason))
    return { client, clientExits }
  }

  test("throwing standalone pump → in-flight request rejects with /exited/, not timeout", async () => {
    const standalone = manualSseResponse()
    const { client, clientExits } = buildClient(standalone)
    await client.start()
    await tick()

    const pending = client.listTools()
    await tick()
    const t0 = Date.now()
    standalone.fail(new Error("proxy dropped the stream"))
    await expect(pending).rejects.toThrow(/exited/)
    // PROMPT rejection: the transport-exit fan-out settled it, not the 30s
    // per-request timeout (whose message says "timed out", asserted absent above).
    expect(Date.now() - t0).toBeLessThan(2_000)
    // The ADR-0435 supervisor subscribes exactly here — it observes the death.
    expect(clientExits).toEqual(["transport exit"])
  })

  test("early-clean-end standalone pump → in-flight request rejects with /exited/, not timeout", async () => {
    const standalone = manualSseResponse()
    const { client, clientExits } = buildClient(standalone)
    await client.start()
    await tick()

    const pending = client.listTools()
    await tick()
    const t0 = Date.now()
    standalone.end()
    await expect(pending).rejects.toThrow(/exited/)
    expect(Date.now() - t0).toBeLessThan(2_000)
    expect(clientExits).toEqual(["transport exit"])
  })
})

describe("finding #11 — GET handshake failure is a death, not silent POST-only", () => {
  test("network blip on the standalone GET → warn-grade exit, channel death visible", async () => {
    const transport = new HttpSseMcpTransport({
      url: "https://srv.example/mcp",
      name: "pump-probe",
      fetch: async (_url, init) => {
        if (init.method === "GET") throw new Error("ECONNREFUSED 127.0.0.1:9")
        return accepted202()
      },
    })
    const exits: (string | undefined)[] = []
    transport.onExit((reason) => exits.push(reason))
    await transport.start()
    await tick()
    expect(exits).toHaveLength(1)
    expect(exits[0]).toMatch(/standalone SSE GET failed/)
    expect(exits[0]).toMatch(/ECONNREFUSED/)
  })

  test("405 on the GET stays spec-legal POST-only (no exit) — escalation is scoped to REAL failures", async () => {
    const transport = new HttpSseMcpTransport({
      url: "https://srv.example/mcp",
      name: "pump-probe",
      fetch: async (_url, init) => {
        if (init.method === "GET") {
          return {
            ok: false,
            status: 405,
            headers: { get: () => null },
            text: async () => "",
            body: null,
          }
        }
        return accepted202()
      },
    })
    const exits: (string | undefined)[] = []
    transport.onExit((reason) => exits.push(reason))
    await transport.start()
    await tick()
    expect(exits).toHaveLength(0)
  })

  test("GET 500 without a resume cursor → exit exactly once", async () => {
    const transport = new HttpSseMcpTransport({
      url: "https://srv.example/mcp",
      name: "pump-probe",
      fetch: async (_url, init) => {
        if (init.method === "GET") {
          return {
            ok: false,
            status: 500,
            headers: { get: () => null },
            text: async () => "boom",
            body: null,
          }
        }
        return accepted202()
      },
    })
    const exits: (string | undefined)[] = []
    transport.onExit((reason) => exits.push(reason))
    await transport.start()
    await tick()
    expect(exits).toHaveLength(1)
    expect(exits[0]).toMatch(/standalone SSE GET failed/)
    expect(exits[0]).toMatch(/HTTP 500/)
  })

  test("stale cursor + GET 500 → one retry without Last-Event-ID, then one exit", async () => {
    const gets: Array<string | undefined> = []
    const transport = new HttpSseMcpTransport({
      url: "https://srv.example/mcp",
      name: "pump-probe",
      resumeFromEventId: "stale-cursor",
      fetch: async (_url, init) => {
        if (init.method === "GET") {
          gets.push(init.headers?.["Last-Event-ID"])
          return {
            ok: false,
            status: 500,
            headers: { get: () => null },
            text: async () => "stale",
            body: null,
          }
        }
        return accepted202()
      },
    })
    const exits: (string | undefined)[] = []
    transport.onExit((reason) => exits.push(reason))
    await transport.start()
    await tick()
    expect(gets).toEqual(["stale-cursor", undefined])
    expect(exits).toHaveLength(1)
    expect(exits[0]).toMatch(/standalone SSE GET failed/)
    expect(exits[0]).toMatch(/HTTP 500/)
  })

  test("GET 200 with application/json content-type → exit exactly once", async () => {
    const transport = new HttpSseMcpTransport({
      url: "https://srv.example/mcp",
      name: "pump-probe",
      fetch: async (_url, init) => {
        if (init.method === "GET") return jsonResponse({ error: "not sse" })
        return accepted202()
      },
    })
    const exits: (string | undefined)[] = []
    transport.onExit((reason) => exits.push(reason))
    await transport.start()
    await tick()
    expect(exits).toHaveLength(1)
    expect(exits[0]).toMatch(/standalone SSE GET failed/)
    expect(exits[0]).toMatch(/unexpected content-type/)
  })

  test("close() during a failing GET response adds no crash exit", async () => {
    const transport = new HttpSseMcpTransport({
      url: "https://srv.example/mcp",
      name: "pump-probe",
      fetch: async (_url, init) => {
        if (init.method === "GET") {
          return new Promise<HttpFetchResponse>((resolve) => {
            init.signal?.addEventListener(
              "abort",
              () =>
                resolve({
                  ok: false,
                  status: 500,
                  headers: { get: () => null },
                  text: async () => "late",
                  body: null,
                }),
              { once: true },
            )
          })
        }
        return accepted202()
      },
    })
    const exits: (string | undefined)[] = []
    transport.onExit((reason) => exits.push(reason))
    await transport.start()
    await tick()
    await transport.close()
    await tick()
    expect(exits).toHaveLength(1)
    expect(exits[0]).toMatch(/closed/)
    expect(exits[0]).not.toMatch(/GET failed/)
  })

  test("paired control — close()-abort of an in-flight handshake stays quiet (single 'closed' exit)", async () => {
    const transport = new HttpSseMcpTransport({
      url: "https://srv.example/mcp",
      name: "pump-probe",
      fetch: async (_url, init) => {
        if (init.method === "GET") {
          // Hang until close() aborts us, then reject like a real fetch would.
          return new Promise<HttpFetchResponse>((_, reject) => {
            init.signal?.addEventListener(
              "abort",
              () => reject(new Error("The operation was aborted")),
              { once: true },
            )
          })
        }
        return accepted202()
      },
    })
    const exits: (string | undefined)[] = []
    transport.onExit((reason) => exits.push(reason))
    await transport.start()
    await tick()
    await transport.close()
    await tick()
    expect(exits).toHaveLength(1)
    expect(exits[0]).toMatch(/closed/)
    expect(exits[0]).not.toMatch(/GET failed/)
  })
})

describe("finding #4 sibling — POST-bound SSE body death rejects ITS pending entry promptly", () => {
  test("tools/list POST answered by an SSE stream that dies pre-reply → prompt typed reject", async () => {
    const postSse = manualSseResponse()
    const fetchFn: HttpFetchFn = async (_url, init) => {
      const body = JSON.parse(init.body ?? "{}") as { id?: number; method?: string }
      if (body.method === "initialize") {
        return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { capabilities: {} } })
      }
      if (body.id === undefined) return accepted202()
      return postSse.res
    }
    const transport = new HttpSseMcpTransport({
      url: "https://srv.example/mcp",
      name: "pump-probe",
      openServerStream: false,
      fetch: fetchFn,
    })
    const client = new McpClient(cfg(), { transport })
    await client.start()

    const pending = client.listTools()
    await tick()
    const t0 = Date.now()
    postSse.fail(new Error("h2 stream RST"))
    await expect(pending).rejects.toThrow(/transport POST SSE stream failed/)
    expect(Date.now() - t0).toBeLessThan(2_000)
    // A single POST-body death is NOT a transport death: the channel contract
    // for the OTHER requests is intact, so no exit fires (scoped escalation).
    let exited = false
    client.onExit(() => {
      exited = true
    })
    await tick()
    expect(exited).toBe(false)
    await client.stop()
  })
})
