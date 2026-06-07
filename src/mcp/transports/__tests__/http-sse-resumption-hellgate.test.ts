import { describe, expect, test } from "bun:test"
import { HttpSseMcpTransport, sseDataFromBlock } from "@/mcp/transports/http-sse"

// §1.2 / ticket-09 — MCP SSE resumption (Last-Event-ID). The transport must:
// parse the SSE `id:` field into a cursor, send `Last-Event-ID` on a
// (re)connect seeded with a prior id, and expose the cursor so the external
// reconnect supervisor (ADR-0435 makes a NEW transport) can carry it across.

interface FetchInit {
  method: string
  headers: Record<string, string>
  body?: string
  signal?: AbortSignal
}
interface FakeResp {
  ok: boolean
  status: number
  headers: { get(n: string): string | null }
  text(): Promise<string>
  body: ReadableStream<Uint8Array> | null
}

/** A finite SSE body that yields `chunk` once then ends. */
const finiteBody = (chunk: string): ReadableStream<Uint8Array> => {
  let sent = false
  return {
    getReader() {
      return {
        read: (): Promise<{ done: boolean; value?: Uint8Array }> => {
          if (sent) return Promise.resolve({ done: true })
          sent = true
          return Promise.resolve({ done: false, value: new TextEncoder().encode(chunk) })
        },
        cancel: async (): Promise<void> => {},
        releaseLock: (): void => {},
      }
    },
  } as unknown as ReadableStream<Uint8Array>
}

describe("sseDataFromBlock — id parse", () => {
  test("parses `id:` + `data:` into a {data,id} pair", () => {
    expect(sseDataFromBlock("id: 42\ndata: hello")).toEqual({ data: "hello", id: "42" })
  })
  test("no id ⇒ id:null; data still extracted", () => {
    expect(sseDataFromBlock("data: x")).toEqual({ data: "x", id: null })
  })
  test("multi `data:` joined; `event:`/comment ignored", () => {
    expect(sseDataFromBlock("event: msg\nid: 7\ndata: a\ndata: b\n: comment")).toEqual({
      data: "a\nb",
      id: "7",
    })
  })
  test("id with trailing CR is trimmed", () => {
    expect(sseDataFromBlock("id: 9\r\ndata: y\r").id).toBe("9")
  })
  test("block with no data ⇒ data:null (last id still surfaced)", () => {
    expect(sseDataFromBlock("id: 5")).toEqual({ data: null, id: "5" })
  })
})

describe("HttpSseMcpTransport — Last-Event-ID resumption", () => {
  test("seeded with resumeFromEventId ⇒ standalone GET carries Last-Event-ID", async () => {
    let getHeaders: Record<string, string> | undefined
    const fetchFn = (_url: string, init: FetchInit): Promise<FakeResp> => {
      if (init.method === "GET") getHeaders = init.headers
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: (n) => (n === "content-type" ? "text/event-stream" : null) },
        text: () => Promise.resolve(""),
        body: finiteBody(""),
      })
    }
    const t = new HttpSseMcpTransport({
      url: "https://mcp.example",
      name: "x",
      openServerStream: true,
      fetch: fetchFn as never,
      resumeFromEventId: "100",
    })
    await t.start()
    await new Promise((r) => setTimeout(r, 5))
    expect(getHeaders?.["Last-Event-ID"]).toBe("100")
    await t.close()
  })

  test("no resume seed ⇒ NO Last-Event-ID header (byte-identical)", async () => {
    let getHeaders: Record<string, string> | undefined
    const fetchFn = (_url: string, init: FetchInit): Promise<FakeResp> => {
      if (init.method === "GET") getHeaders = init.headers
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: (n) => (n === "content-type" ? "text/event-stream" : null) },
        text: () => Promise.resolve(""),
        body: finiteBody(""),
      })
    }
    const t = new HttpSseMcpTransport({
      url: "https://mcp.example",
      name: "x",
      openServerStream: true,
      fetch: fetchFn as never,
    })
    await t.start()
    await new Promise((r) => setTimeout(r, 5))
    expect(getHeaders && "Last-Event-ID" in getHeaders).toBe(false)
    expect(t.getLastEventId()).toBeNull()
    await t.close()
  })

  test("consuming an SSE event with `id:` advances the cursor (getLastEventId)", async () => {
    const fetchFn = (_url: string, init: FetchInit): Promise<FakeResp> => {
      if (init.method === "GET") {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: (n) => (n === "content-type" ? "text/event-stream" : null) },
          text: () => Promise.resolve(""),
          // a server→client notification with an event id, then stream ends.
          body: finiteBody('id: 314\ndata: {"jsonrpc":"2.0","method":"notifications/ping"}\n\n'),
        })
      }
      return Promise.resolve({
        ok: true,
        status: 202,
        headers: { get: () => null },
        text: () => Promise.resolve(""),
        body: null,
      })
    }
    const t = new HttpSseMcpTransport({
      url: "https://mcp.example",
      name: "x",
      openServerStream: true,
      fetch: fetchFn as never,
    })
    await t.start()
    await new Promise((r) => setTimeout(r, 10))
    expect(t.getLastEventId()).toBe("314")
    await t.close()
  })
})
