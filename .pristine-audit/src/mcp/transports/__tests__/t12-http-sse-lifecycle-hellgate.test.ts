/**
 * T12 hellgate — MCP HTTP-SSE owns BOTH lifetimes; close() aborts together
 * (audit L9 H12). Builds on T01 (which proved the POST lifetime + reader
 * cancel): here we seal the STANDALONE-GET lifetime — close() must sever the
 * server-initiated SSE channel and cancel its reader, and a close() that races
 * the GET handshake must NOT open a reader on a torn-down transport.
 */

import { describe, expect, test } from "bun:test"
import { HttpSseMcpTransport } from "@/mcp/transports/http-sse"

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

/** An unbounded SSE body that only ends when its reader is cancelled. */
const makeHangingBody = (track: { cancelled: boolean }): ReadableStream<Uint8Array> =>
  ({
    getReader() {
      return {
        read: (): Promise<{ done: boolean; value?: Uint8Array }> =>
          track.cancelled ? Promise.resolve({ done: true }) : new Promise<never>(() => {}),
        cancel: async (): Promise<void> => {
          track.cancelled = true
        },
        releaseLock: (): void => {},
      }
    },
  }) as unknown as ReadableStream<Uint8Array>

describe("T12 / H12 — standalone GET SSE lifetime is aborted on close()", () => {
  test("close() aborts the standalone GET signal and cancels its reader", async () => {
    let getSignalAborted = false
    const track = { cancelled: false }

    const fetchFn = (_url: string, init: FetchInit): Promise<FakeResp> => {
      if (init.method === "GET") {
        init.signal?.addEventListener("abort", () => {
          getSignalAborted = true
        })
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: (n) => (n === "content-type" ? "text/event-stream" : null) },
          text: () => Promise.resolve(""),
          body: makeHangingBody(track),
        })
      }
      // DELETE on close — trivially empty.
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
      name: "t12-get",
      openServerStream: true,
      // biome-ignore lint/suspicious/noExplicitAny: test fetch seam shape match
      fetch: fetchFn as any,
    })
    await t.start()
    // Let the GET begin draining the unbounded body.
    await new Promise((r) => setTimeout(r, 5))
    await t.close()
    await new Promise((r) => setTimeout(r, 5))

    expect(getSignalAborted).toBe(true)
    expect(track.cancelled).toBe(true)
  })

  test("close() racing the GET handshake never opens a reader on a dead transport", async () => {
    let readerOpened = false
    let resolveGet: ((r: FakeResp) => void) | undefined

    const fetchFn = (_url: string, init: FetchInit): Promise<FakeResp> => {
      if (init.method === "GET") {
        // Defer the GET response so we can close() while it is "in flight".
        return new Promise<FakeResp>((resolve) => {
          resolveGet = resolve
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
      name: "t12-race",
      openServerStream: true,
      // biome-ignore lint/suspicious/noExplicitAny: test fetch seam shape match
      fetch: fetchFn as any,
    })
    await t.start()
    // Close BEFORE resolving the GET → the transport is torn down.
    await t.close()
    // Now resolve the GET with an SSE body — the transport must NOT begin draining.
    resolveGet?.({
      ok: true,
      status: 200,
      headers: { get: (n) => (n === "content-type" ? "text/event-stream" : null) },
      text: () => Promise.resolve(""),
      body: {
        getReader() {
          readerOpened = true
          return {
            read: (): Promise<{ done: boolean }> => Promise.resolve({ done: true }),
            cancel: async (): Promise<void> => {},
            releaseLock: (): void => {},
          }
        },
      } as unknown as ReadableStream<Uint8Array>,
    })
    await new Promise((r) => setTimeout(r, 5))

    expect(readerOpened).toBe(false)
  })
})
