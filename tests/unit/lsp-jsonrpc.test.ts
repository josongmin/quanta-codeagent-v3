import { describe, expect, test } from "bun:test"
import type { JsonRpcMessage } from "@/lsp/adapters/jsonrpc"
import { encodeMessage, MessageReader } from "@/lsp/adapters/jsonrpc"

const decode = (b: Uint8Array): string => new TextDecoder().decode(b)

/** Build a Content-Length frame from an arbitrary JSON string body (byte-correct). */
const frame = (json: string): Uint8Array => {
  const body = new TextEncoder().encode(json)
  const header = new TextEncoder().encode(`Content-Length: ${body.byteLength}\r\n\r\n`)
  const out = new Uint8Array(header.byteLength + body.byteLength)
  out.set(header, 0)
  out.set(body, header.byteLength)
  return out
}

describe("encodeMessage", () => {
  test("produces exact Content-Length \\r\\n\\r\\n framing", () => {
    const payload = { jsonrpc: "2.0", id: 1, method: "initialize" }
    const json = JSON.stringify(payload)
    const bytes = encodeMessage(payload)
    const text = decode(bytes)
    expect(text).toBe(`Content-Length: ${json.length}\r\n\r\n${json}`)
    expect(text.includes("\r\n\r\n")).toBe(true)
  })

  test("Content-Length is the UTF-8 byte length, not the char length", () => {
    // "é" is 1 JS char but 2 UTF-8 bytes; an emoji is 2 chars / 4 bytes.
    const payload = { msg: "é😀" }
    const json = JSON.stringify(payload)
    const byteLen = new TextEncoder().encode(json).byteLength
    expect(byteLen).toBeGreaterThan(json.length)

    const bytes = encodeMessage(payload)
    const headerText = decode(bytes).split("\r\n\r\n")[0] ?? ""
    expect(headerText).toBe(`Content-Length: ${byteLen}`)

    // Body bytes after the separator must equal the declared length exactly.
    const sepBytes = new TextEncoder().encode(`${headerText}\r\n\r\n`)
    expect(bytes.byteLength - sepBytes.byteLength).toBe(byteLen)
  })

  test("round-trips through MessageReader to the original value", () => {
    const payload = { jsonrpc: "2.0", id: 7, result: { ok: true } }
    const reader = new MessageReader()
    const msgs = reader.push(encodeMessage(payload))
    expect(msgs).toEqual([payload as unknown as JsonRpcMessage])
  })
})

describe("MessageReader", () => {
  test("parses a single complete message in one push", () => {
    const reader = new MessageReader()
    const out = reader.push(frame('{"jsonrpc":"2.0","method":"ping"}'))
    expect(out).toEqual([{ jsonrpc: "2.0", method: "ping" }])
  })

  test("splits multiple coalesced messages from one chunk", () => {
    const reader = new MessageReader()
    const a = frame('{"jsonrpc":"2.0","id":1,"result":1}')
    const b = frame('{"jsonrpc":"2.0","id":2,"result":2}')
    const combined = new Uint8Array(a.byteLength + b.byteLength)
    combined.set(a, 0)
    combined.set(b, a.byteLength)

    const out = reader.push(combined)
    expect(out).toEqual([
      { jsonrpc: "2.0", id: 1, result: 1 },
      { jsonrpc: "2.0", id: 2, result: 2 },
    ])
  })

  test("returns nothing until the full body has arrived (mid-body split)", () => {
    const reader = new MessageReader()
    const full = frame('{"jsonrpc":"2.0","id":9,"result":"done"}')
    const cut = full.byteLength - 5

    expect(reader.push(full.subarray(0, cut))).toEqual([])
    const out = reader.push(full.subarray(cut))
    expect(out).toEqual([{ jsonrpc: "2.0", id: 9, result: "done" }])
  })

  test("reassembles a message split mid-header", () => {
    const reader = new MessageReader()
    const full = frame('{"jsonrpc":"2.0","method":"x"}')
    // Cut inside the "Content-Length" header text itself.
    expect(reader.push(full.subarray(0, 6))).toEqual([])
    expect(reader.push(full.subarray(6, 10))).toEqual([])
    const out = reader.push(full.subarray(10))
    expect(out).toEqual([{ jsonrpc: "2.0", method: "x" }])
  })

  test("reassembles when split exactly on the \\r\\n\\r\\n separator", () => {
    const reader = new MessageReader()
    const json = '{"jsonrpc":"2.0","id":3}'
    const full = frame(json)
    const headerOnly = new TextEncoder().encode(`Content-Length: ${json.length}`)
    // Split right between header text and the separator.
    expect(reader.push(full.subarray(0, headerOnly.byteLength))).toEqual([])
    const out = reader.push(full.subarray(headerOnly.byteLength))
    expect(out).toEqual([{ jsonrpc: "2.0", id: 3 }])
  })

  test("handles UTF-8 multibyte body split across the boundary", () => {
    const reader = new MessageReader()
    const json = JSON.stringify({ jsonrpc: "2.0", method: "log", params: "héllo😀" })
    const full = frame(json)
    // Split somewhere inside the multibyte body region.
    const mid = full.byteLength - 3
    expect(reader.push(full.subarray(0, mid))).toEqual([])
    const out = reader.push(full.subarray(mid))
    expect(out).toEqual([{ jsonrpc: "2.0", method: "log", params: "héllo😀" }])
  })

  test("byte-by-byte feeding still yields exactly one message", () => {
    const reader = new MessageReader()
    const full = frame('{"jsonrpc":"2.0","id":42,"result":[1,2,3]}')
    let collected: JsonRpcMessage[] = []
    for (let i = 0; i < full.byteLength; i++) {
      collected = collected.concat(reader.push(full.subarray(i, i + 1)))
    }
    expect(collected).toEqual([{ jsonrpc: "2.0", id: 42, result: [1, 2, 3] }])
  })

  test("a malformed header (no Content-Length) is dropped without wedging the stream", () => {
    const reader = new MessageReader()
    const bogusHeader = new TextEncoder().encode("X-Bad: 1\r\n\r\n")
    const good = frame('{"jsonrpc":"2.0","method":"after"}')
    const combined = new Uint8Array(bogusHeader.byteLength + good.byteLength)
    combined.set(bogusHeader, 0)
    combined.set(good, bogusHeader.byteLength)

    // Dropping the bad header returns null, which ends the current batch loop;
    // the buffered valid message survives and is emitted on the next push.
    expect(reader.push(combined)).toEqual([])
    expect(reader.push(new Uint8Array(0))).toEqual([{ jsonrpc: "2.0", method: "after" }])
  })

  test("an invalid JSON body is swallowed (no throw) and stops the batch", () => {
    const reader = new MessageReader()
    const out = reader.push(frame("{not valid json"))
    expect(out).toEqual([])
  })

  test("recovers after a bad-JSON message when more arrives later", () => {
    const reader = new MessageReader()
    expect(reader.push(frame("{broken"))).toEqual([])
    const out = reader.push(frame('{"jsonrpc":"2.0","method":"recovered"}'))
    expect(out).toEqual([{ jsonrpc: "2.0", method: "recovered" }])
  })

  test("empty push returns no messages and keeps state intact", () => {
    const reader = new MessageReader()
    expect(reader.push(new Uint8Array(0))).toEqual([])
    const out = reader.push(frame('{"jsonrpc":"2.0","id":1}'))
    expect(out).toEqual([{ jsonrpc: "2.0", id: 1 }])
  })

  test("case-insensitive Content-Length header is accepted", () => {
    const reader = new MessageReader()
    const json = '{"jsonrpc":"2.0","method":"ci"}'
    const body = new TextEncoder().encode(json)
    const header = new TextEncoder().encode(`content-length: ${body.byteLength}\r\n\r\n`)
    const buf = new Uint8Array(header.byteLength + body.byteLength)
    buf.set(header, 0)
    buf.set(body, header.byteLength)

    expect(reader.push(buf)).toEqual([{ jsonrpc: "2.0", method: "ci" }])
  })
})
