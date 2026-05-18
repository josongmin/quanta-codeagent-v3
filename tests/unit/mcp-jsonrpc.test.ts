import { describe, expect, it } from "bun:test"
import { encodeMessage, type JsonRpcMessage, LineReader } from "@/mcp/jsonrpc"

const enc = (s: string) => new TextEncoder().encode(s)

describe("mcp jsonrpc codec", () => {
  it("encodes as a single newline-terminated JSON line", () => {
    const bytes = encodeMessage({ jsonrpc: "2.0", id: 1, method: "ping" })
    const text = new TextDecoder().decode(bytes)
    expect(text.endsWith("\n")).toBe(true)
    expect(text.indexOf("\n")).toBe(text.length - 1)
    expect(JSON.parse(text.trimEnd())).toEqual({ jsonrpc: "2.0", id: 1, method: "ping" })
  })

  it("round-trips a message through encode → reader", () => {
    const msg: JsonRpcMessage = { jsonrpc: "2.0", id: 7, result: { ok: true } }
    const out = new LineReader().push(encodeMessage(msg))
    expect(out).toEqual([msg])
  })
})

describe("mcp LineReader framing", () => {
  it("emits multiple messages coalesced in one chunk", () => {
    const reader = new LineReader()
    const a = JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 })
    const b = JSON.stringify({ jsonrpc: "2.0", id: 2, result: 2 })
    const out = reader.push(enc(`${a}\n${b}\n`))
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({ jsonrpc: "2.0", id: 1, result: 1 })
    expect(out[1]).toEqual({ jsonrpc: "2.0", id: 2, result: 2 })
  })

  it("buffers a message split across chunks", () => {
    const reader = new LineReader()
    const full = JSON.stringify({ jsonrpc: "2.0", id: 9, result: { v: "héllo" } })
    const mid = Math.floor(full.length / 2)
    expect(reader.push(enc(full.slice(0, mid)))).toEqual([])
    const out = reader.push(enc(`${full.slice(mid)}\n`))
    expect(out).toEqual([{ jsonrpc: "2.0", id: 9, result: { v: "héllo" } }])
  })

  it("splits a multibyte char across a chunk boundary", () => {
    const reader = new LineReader()
    const bytes = enc(`${JSON.stringify({ jsonrpc: "2.0", id: 3, result: "€" })}\n`)
    const cut = bytes.indexOf(0xe2) + 1 // mid UTF-8 sequence for €
    expect(reader.push(bytes.subarray(0, cut))).toEqual([])
    const out = reader.push(bytes.subarray(cut))
    expect(out).toEqual([{ jsonrpc: "2.0", id: 3, result: "€" }])
  })

  it("tolerates blank lines between messages", () => {
    const reader = new LineReader()
    const a = JSON.stringify({ jsonrpc: "2.0", id: 1, result: "a" })
    const out = reader.push(enc(`\n\n${a}\n\n`))
    expect(out).toEqual([{ jsonrpc: "2.0", id: 1, result: "a" }])
  })

  it("skips a malformed JSON line without wedging the stream", () => {
    const reader = new LineReader()
    const good = JSON.stringify({ jsonrpc: "2.0", id: 5, result: "ok" })
    const out = reader.push(enc(`{not json\n${good}\n`))
    expect(out).toEqual([{ jsonrpc: "2.0", id: 5, result: "ok" }])
  })

  it("returns nothing for an incomplete trailing line", () => {
    const reader = new LineReader()
    expect(reader.push(enc('{"jsonrpc":"2.0","id":1'))).toEqual([])
  })
})
