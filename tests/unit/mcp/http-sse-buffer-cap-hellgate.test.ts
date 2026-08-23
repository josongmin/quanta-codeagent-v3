/**
 * aug-23 audit — SSE event-buffer cap (companion to the JSON-RPC line cap).
 *
 * `consumeSseBody` accumulated `buffer += decode(chunk)` and only ever drained
 * on a `\n\n` event boundary. A hostile — or merely broken — MCP server that
 * streams bytes and never emits a blank line grew that string without bound:
 * the same one-line OOM the stdio framer had, arriving over the other transport.
 * Measured before the fix: 32MB fed in, 32MB buffered.
 *
 * The stdio side was capped first (`MAX_LINE_BYTES`, itself mirroring
 * `plugin-isolation/bun-spawner`'s `MAX_MESSAGE_BYTES`). This is the SAME threat
 * reaching the SAME process through the other transport, so it takes the SAME
 * constant — two divergent budgets for one hostile-server threat would drift.
 *
 * Tested through the extracted PURE framer rather than a test-only backdoor on
 * the transport class: the cap and the boundary walk are the whole behaviour,
 * and a pure function can be driven with a 32MB string without a live server.
 */

import { describe, expect, test } from "bun:test"
import { MAX_LINE_BYTES } from "@/mcp/jsonrpc"
import { MAX_SSE_BUFFER_BYTES, takeSseBlocks } from "@/mcp/transports/http-sse"

describe("SSE event-buffer cap (aug-23 audit)", () => {
  test("the cap mirrors the stdio framer's, not a second invented budget", () => {
    expect(MAX_SSE_BUFFER_BYTES).toBe(MAX_LINE_BYTES)
  })

  test("a stream with no event boundary cannot grow past the cap", () => {
    // 32MB of body with not one `\n\n` — the exact hostile shape.
    const flood = "x".repeat(MAX_SSE_BUFFER_BYTES + 1024 * 1024)
    const taken = takeSseBlocks(flood)
    expect(taken.dropped).toBe(true)
    expect(taken.blocks).toEqual([])
    expect(taken.rest.length).toBeLessThanOrEqual(MAX_SSE_BUFFER_BYTES)
  })

  test("an over-cap block is dropped and framing RESYNCS at the next boundary", () => {
    const flood = "x".repeat(MAX_SSE_BUFFER_BYTES + 1)
    const taken = takeSseBlocks(`${flood}\n\ndata: after\n\n`)
    expect(taken.dropped).toBe(true)
    expect(taken.blocks).toEqual(["data: after"])
    expect(taken.rest).toBe("")
  })

  // PAIRED CONTROLS — the cap must not disturb ordinary framing.
  test("well-formed events still split, and a partial tail is preserved", () => {
    const taken = takeSseBlocks("data: one\n\ndata: two\n\ndata: par")
    expect(taken.dropped).toBe(false)
    expect(taken.blocks).toEqual(["data: one", "data: two"])
    expect(taken.rest).toBe("data: par")
  })

  test("an under-cap event is delivered whole", () => {
    const big = "y".repeat(1024 * 1024)
    const taken = takeSseBlocks(`data: ${big}\n\n`)
    expect(taken.dropped).toBe(false)
    expect(taken.blocks).toEqual([`data: ${big}`])
  })

  test("an empty buffer is a no-op", () => {
    expect(takeSseBlocks("")).toEqual({ blocks: [], rest: "", dropped: false })
  })
})
