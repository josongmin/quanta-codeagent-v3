/**
 * W5 DAP — Debug Adapter Protocol wire codec (the novel core). DAP frames are
 * `Content-Length: <N>\r\n\r\n<JSON>` where N is the UTF-8 BYTE length of the
 * body (LSP-style). The decoder must survive every TCP-stream reality: a frame
 * split across reads, several frames in one read, multibyte bodies (byte ≠ char
 * length), and a malformed header — without throwing. Pure + stateful-decoder
 * TDD (the framing is the hellgate-grade part).
 */
import { describe, expect, test } from "bun:test"
import { DapFrameDecoder, encodeDapMessage } from "@/tool/debug/dap-codec"

const decodeAll = (chunks: string[]): unknown[] => {
  const dec = new DapFrameDecoder()
  const out: unknown[] = []
  for (const c of chunks) out.push(...dec.push(c))
  return out
}

describe("encodeDapMessage", () => {
  test("frames with Content-Length = UTF-8 BYTE length + CRLFCRLF separator", () => {
    const wire = encodeDapMessage({ seq: 1, type: "request", command: "initialize" })
    const body = JSON.stringify({ seq: 1, type: "request", command: "initialize" })
    expect(wire).toBe(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`)
  })

  test("byte length, not char length, for multibyte bodies", () => {
    const wire = encodeDapMessage({ command: "evaluate", expression: "안녕 + 世界" })
    const header = wire.slice(0, wire.indexOf("\r\n\r\n"))
    const body = wire.slice(wire.indexOf("\r\n\r\n") + 4)
    expect(header).toBe(`Content-Length: ${Buffer.byteLength(body, "utf8")}`)
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(body.length) // multibyte ⇒ bytes>chars
  })
})

describe("DapFrameDecoder", () => {
  test("roundtrip: encode → decode one message", () => {
    const msg = { seq: 3, type: "response", command: "stackTrace", success: true }
    expect(decodeAll([encodeDapMessage(msg)])).toEqual([msg])
  })

  test("MULTIPLE frames in a single chunk are all decoded, in order", () => {
    const a = { seq: 1, command: "initialize" }
    const b = { seq: 2, command: "launch" }
    const c = { seq: 3, event: "stopped" }
    expect(decodeAll([encodeDapMessage(a) + encodeDapMessage(b) + encodeDapMessage(c)])).toEqual([
      a,
      b,
      c,
    ])
  })

  test("a frame SPLIT across chunks (header break + body break) decodes once whole", () => {
    const msg = { seq: 9, event: "stopped", body: { reason: "breakpoint", threadId: 1 } }
    const wire = encodeDapMessage(msg)
    // Split mid-header AND mid-body across three reads.
    const p1 = wire.slice(0, 8)
    const p2 = wire.slice(8, wire.length - 5)
    const p3 = wire.slice(wire.length - 5)
    const dec = new DapFrameDecoder()
    expect(dec.push(p1)).toEqual([])
    expect(dec.push(p2)).toEqual([])
    expect(dec.push(p3)).toEqual([msg])
  })

  test("multibyte body split across chunks (raw Buffer reads) decodes by BYTE boundary", () => {
    const msg = { event: "output", body: { output: "결과: 한글 출력 テスト" } }
    const wire = encodeDapMessage(msg)
    const bytes = Buffer.from(wire, "utf8")
    // Split at a raw byte offset that lands MID-multibyte-char — exactly what a
    // child-process stdout 'data' event delivers. The decoder accumulates BYTES
    // (Buffer), so the codepoint reassembles whole.
    const mid = bytes.length - 7
    const dec = new DapFrameDecoder()
    expect(dec.push(bytes.subarray(0, mid))).toEqual([])
    expect(dec.push(bytes.subarray(mid))).toEqual([msg])
  })

  test("malformed Content-Length header ⇒ does NOT throw (skips, recovers on next valid frame)", () => {
    const dec = new DapFrameDecoder()
    expect(() => dec.push("Content-Length: notanumber\r\n\r\n{}")).not.toThrow()
    // A valid frame after the garbage still decodes.
    const ok = { seq: 1, command: "threads" }
    const after = dec.push(encodeDapMessage(ok))
    expect(after).toEqual([ok])
  })

  test("empty / whitespace push ⇒ [] (no throw)", () => {
    const dec = new DapFrameDecoder()
    expect(dec.push("")).toEqual([])
  })

  test("body that is not valid JSON ⇒ skipped, never throws", () => {
    const dec = new DapFrameDecoder()
    const garbage = `Content-Length: 5\r\n\r\n{ bad`
    expect(() => dec.push(garbage)).not.toThrow()
  })
})
