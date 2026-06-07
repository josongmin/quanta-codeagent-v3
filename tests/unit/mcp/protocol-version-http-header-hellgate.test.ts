/**
 * MCP protocol-version HTTP header-timing hellgate (ticket misc-jun-7/01).
 *
 * The `mcp-protocol-version` header must carry:
 *   - the OFFERED version on the `initialize` POST (negotiation hasn't run yet),
 *   - the PINNED (server-chosen) version on EVERY subsequent request.
 *
 * Drives the REAL `HttpSseMcpTransport` through a fake `fetch`, then a full
 * `McpClient` over it, so the end-to-end header pin is proven (not just the
 * setter in isolation). No network.
 */
import { describe, expect, test } from "bun:test"
import {
  type HttpFetchFn,
  type HttpFetchResponse,
  HttpSseMcpTransport,
  LATEST_PROTOCOL_VERSION,
  McpClient,
  type McpServerConfig,
} from "@/mcp"

const jsonResponse = (body: unknown): HttpFetchResponse => ({
  ok: true,
  status: 200,
  headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "application/json" : null) },
  text: async () => JSON.stringify(body),
  body: null,
})

const accepted = (): HttpFetchResponse => ({
  ok: true,
  status: 202,
  headers: { get: () => null },
  text: async () => "",
  body: null,
})

interface Captured {
  method: string
  protocolHeader: string | undefined
  rpcMethod: string | undefined
}

/** A fake fetch that records the `mcp-protocol-version` header per request and
 *  answers `initialize` with a server-chosen `protocolVersion`, `tools/list`
 *  with an empty list, and the `notifications/initialized` POST with 202. */
const makeFetch = (serverChoice: string | undefined, log: Captured[]): HttpFetchFn => {
  return async (_url, init) => {
    const protocolHeader = init.headers["mcp-protocol-version"]
    if (init.method !== "POST") {
      // The standalone GET SSE channel — answer 405 (no server stream).
      return {
        ok: false,
        status: 405,
        headers: { get: () => null },
        text: async () => "",
        body: null,
      }
    }
    const payload = init.body ? (JSON.parse(init.body) as { method?: string; id?: number }) : {}
    log.push({ method: init.method, protocolHeader, rpcMethod: payload.method })
    if (payload.method === "initialize") {
      return jsonResponse({
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          ...(serverChoice !== undefined ? { protocolVersion: serverChoice } : {}),
          capabilities: { tools: {} },
        },
      })
    }
    if (payload.method === "notifications/initialized") return accepted()
    if (payload.method === "tools/list") {
      return jsonResponse({ jsonrpc: "2.0", id: payload.id, result: { tools: [] } })
    }
    return accepted()
  }
}

const httpCfg = (): McpServerConfig => ({
  name: "remote",
  command: [],
  url: "https://srv.example/mcp",
})

const buildTransport = (fetchFn: HttpFetchFn, offered?: string): HttpSseMcpTransport =>
  new HttpSseMcpTransport({
    url: "https://srv.example/mcp",
    name: "remote",
    fetch: fetchFn,
    openServerStream: false,
    ...(offered !== undefined ? { protocolVersion: offered } : {}),
  })

describe("HTTP header — offered on initialize, pinned thereafter", () => {
  test("server downgrades to 2025-06-18 ⇒ initialize POST offered newest, tools/list carries the pinned older value", async () => {
    const log: Captured[] = []
    const transport = buildTransport(makeFetch("2025-06-18", log), LATEST_PROTOCOL_VERSION)
    const client = new McpClient(httpCfg(), { transport })
    await client.start()
    await client.listTools()
    await client.stop()

    const init = log.find((l) => l.rpcMethod === "initialize")
    const list = log.find((l) => l.rpcMethod === "tools/list")
    expect(init?.protocolHeader).toBe(LATEST_PROTOCOL_VERSION) // offered, pre-negotiation
    expect(list?.protocolHeader).toBe("2025-06-18") // PINNED server choice
    expect(client.pinnedProtocolVersion()).toBe("2025-06-18")
  })

  test("server accepts newest ⇒ header carries newest throughout", async () => {
    const log: Captured[] = []
    const transport = buildTransport(
      makeFetch(LATEST_PROTOCOL_VERSION, log),
      LATEST_PROTOCOL_VERSION,
    )
    const client = new McpClient(httpCfg(), { transport })
    await client.start()
    await client.listTools()
    await client.stop()
    const list = log.find((l) => l.rpcMethod === "tools/list")
    expect(list?.protocolHeader).toBe(LATEST_PROTOCOL_VERSION)
  })

  test("legacy server omits protocolVersion ⇒ header pinned to the offered value (no regression)", async () => {
    const log: Captured[] = []
    const transport = buildTransport(makeFetch(undefined, log), LATEST_PROTOCOL_VERSION)
    const client = new McpClient(httpCfg(), { transport })
    await client.start()
    await client.listTools()
    await client.stop()
    const list = log.find((l) => l.rpcMethod === "tools/list")
    expect(list?.protocolHeader).toBe(LATEST_PROTOCOL_VERSION)
    expect(client.pinnedProtocolVersion()).toBe(LATEST_PROTOCOL_VERSION)
  })
})

describe("transport setter — direct contract", () => {
  test("setProtocolVersion re-pins the header value used by subsequent requests", () => {
    const transport = buildTransport(makeFetch("2025-06-18", []), LATEST_PROTOCOL_VERSION)
    const headers0 = (
      transport as unknown as {
        requestHeaders(extra: Record<string, string>): Record<string, string>
      }
    ).requestHeaders({})
    expect(headers0["mcp-protocol-version"]).toBe(LATEST_PROTOCOL_VERSION)
    transport.setProtocolVersion("2025-03-26")
    const headers1 = (
      transport as unknown as {
        requestHeaders(extra: Record<string, string>): Record<string, string>
      }
    ).requestHeaders({})
    expect(headers1["mcp-protocol-version"]).toBe("2025-03-26")
  })
})
