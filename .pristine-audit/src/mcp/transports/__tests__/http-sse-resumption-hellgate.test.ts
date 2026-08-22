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

describe("HttpSseMcpTransport — unknown/expired cursor reset (§1.2 fallback)", () => {
  test("non-405 GET failure WHILE carrying Last-Event-ID ⇒ drop cursor + retry ONCE without it", async () => {
    const getCalls: Array<Record<string, string>> = []
    const fetchFn = (_url: string, init: FetchInit): Promise<FakeResp> => {
      if (init.method === "GET") {
        getCalls.push(init.headers)
        // First GET (carries the stale cursor) → server rejects (409 Conflict,
        // e.g. unknown session). Retry (no cursor) → 200 OK.
        const isRetry = getCalls.length > 1
        return Promise.resolve({
          ok: isRetry,
          status: isRetry ? 200 : 409,
          headers: { get: (n) => (n === "content-type" ? "text/event-stream" : null) },
          text: () => Promise.resolve(""),
          body: finiteBody(""),
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
      resumeFromEventId: "50",
    })
    await t.start()
    await new Promise((r) => setTimeout(r, 10))
    expect(getCalls).toHaveLength(2) // exactly ONE retry, no loop
    expect(getCalls[0]?.["Last-Event-ID"]).toBe("50") // first carried the cursor
    expect(getCalls[1] && "Last-Event-ID" in getCalls[1]).toBe(false) // retry dropped it
    expect(t.getLastEventId()).toBeNull() // cursor reset
    await t.close()
  })

  test("405 (no standalone stream) ⇒ NO reset, NO retry (spec-legal, not a resume failure)", async () => {
    const getCalls: Array<Record<string, string>> = []
    const fetchFn = (_url: string, init: FetchInit): Promise<FakeResp> => {
      if (init.method === "GET") {
        getCalls.push(init.headers)
        return Promise.resolve({
          ok: false,
          status: 405,
          headers: { get: () => null },
          text: () => Promise.resolve(""),
          body: null,
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
      resumeFromEventId: "50",
    })
    await t.start()
    await new Promise((r) => setTimeout(r, 10))
    expect(getCalls).toHaveLength(1) // no retry on 405
    expect(t.getLastEventId()).toBe("50") // cursor preserved (405 ≠ bad cursor)
    await t.close()
  })
})

describe("sseDataFromBlock — audit R1 hardening", () => {
  test("EMPTY / all-whitespace id field ⇒ id:null (no malformed Last-Event-ID later)", () => {
    expect(sseDataFromBlock("id:\ndata: x").id).toBeNull()
    expect(sseDataFromBlock("id: \ndata: x").id).toBeNull()
    expect(sseDataFromBlock("id:  \ndata: x").id).toBeNull() // R2#1 multi-space
    expect(sseDataFromBlock("id:\t\ndata: x").id).toBeNull() // R2#1 tab
  })
  test("id value MAY contain a colon (field is text after the FIRST colon)", () => {
    expect(sseDataFromBlock("id: a:b\ndata: x").id).toBe("a:b")
  })
  test("a later EMPTY id RESETS a prior non-empty id to null (last-wins)", () => {
    expect(sseDataFromBlock("id: 7\nid:\ndata: x").id).toBeNull()
  })
})

describe("HttpSseMcpTransport — audit R1#4/R2#2: trailing cursor only on COMPLETE lines", () => {
  const driveGet = async (body: string): Promise<string | null> => {
    const fetchFn = (_url: string, init: FetchInit): Promise<FakeResp> => {
      if (init.method === "GET") {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: (n) => (n === "content-type" ? "text/event-stream" : null) },
          text: () => Promise.resolve(""),
          body: finiteBody(body),
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
    const cursor = t.getLastEventId()
    await t.close()
    return cursor
  }

  test("a COMPLETE trailing event (ends \\n, no \\n\\n) ADVANCES the cursor (R2#2: no dup replay)", async () => {
    // complete event id 10, then a complete-but-not-blank-terminated event id 11.
    expect(await driveGet("id: 10\ndata: a\n\nid: 11\ndata: b\n")).toBe("11")
  })

  test("a CUT trailing block (no final \\n, mid-line) does NOT record a truncated id (R1#4)", async () => {
    // event 10 dispatched; then the stream is cut mid-line at `id: 1` (no \n).
    expect(await driveGet("id: 10\ndata: a\n\nid: 1")).toBe("10")
  })
})
