/** SECURITY hellgate — `LineReader` must bound the bytes it buffers.
 *
 *  THREAT. `push()` concatenates every chunk into one growing buffer and
 *  `nextLine()` only ever slices at a `\n`. A hostile (or wedged) MCP server
 *  that streams megabytes WITHOUT a newline therefore grows our heap without
 *  limit — a one-line OOM of the whole agent process. This is a gap INSIDE the
 *  file's own established threat model: it already treats the stream as
 *  adversarial (S15 envelope validation, `.slice(0, 200)` on logged lines).
 *
 *  Sibling precedent: `src/plugin-isolation/bun-spawner.ts`
 *  (`MAX_MESSAGE_BYTES = 10MB`) — an over-cap line is DROPPED + warn-logged and
 *  the reader RESYNCS at the next newline rather than wedging.
 *
 *  Control group: an under-cap line (including a 1MB one), coalesced framing,
 *  cross-chunk splits and blank lines all behave exactly as before. */

import { describe, expect, test } from "bun:test"
import { LineReader, MAX_LINE_BYTES } from "@/mcp/jsonrpc"

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

/** White-box probe of the buffered byte count — the OOM invariant IS the
 *  buffer size, and no black-box signal exposes it while the line is still
 *  unterminated. */
const bufferedBytes = (r: LineReader): number =>
  (r as unknown as { buffer: Uint8Array }).buffer.byteLength

const MB = 1024 * 1024

describe("LineReader byte cap — unterminated stream cannot grow the heap", () => {
  test("30MB with no newline stays bounded by the cap", () => {
    const reader = new LineReader()
    const chunk = enc("A".repeat(MB))
    for (let i = 0; i < 30; i++) expect(reader.push(chunk)).toEqual([])
    expect(bufferedBytes(reader)).toBeLessThanOrEqual(MAX_LINE_BYTES + MB)
  })

  test("an over-cap LINE is dropped and the reader resyncs on the next line", () => {
    const reader = new LineReader()
    // A syntactically VALID, cap-busting JSON-RPC message: pre-cap this parsed
    // and was handed to the caller (memory blow-up accepted); post-cap it is
    // refused, and — the resync part — the NEXT line still parses.
    const huge = JSON.stringify({ jsonrpc: "2.0", id: 1, result: "B".repeat(11 * MB) })
    expect(reader.push(enc(`${huge}\n`))).toEqual([])
    expect(bufferedBytes(reader)).toBeLessThanOrEqual(MAX_LINE_BYTES + MB)
    expect(reader.push(enc('{"jsonrpc":"2.0","id":2,"result":"ok"}\n'))).toEqual([
      { jsonrpc: "2.0", id: 2, result: "ok" },
    ])
  })

  test("an over-cap line split ACROSS chunks still resyncs mid-chunk", () => {
    const reader = new LineReader()
    const chunk = enc("C".repeat(MB))
    for (let i = 0; i < 12; i++) reader.push(chunk)
    // tail of the poisoned line + a good message in the SAME chunk
    const out = reader.push(enc('CCC\n{"jsonrpc":"2.0","id":3,"result":"ok"}\n'))
    expect(out).toEqual([{ jsonrpc: "2.0", id: 3, result: "ok" }])
  })
})

describe("LineReader control group — legitimate framing is unchanged", () => {
  test("a large UNDER-cap line still parses", () => {
    const reader = new LineReader()
    const big = JSON.stringify({ jsonrpc: "2.0", id: 9, result: "D".repeat(MB) })
    const out = reader.push(enc(`${big}\n`))
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual(JSON.parse(big))
  })

  test("coalesced, split and blank-line framing behave as before", () => {
    const reader = new LineReader()
    const a = '{"jsonrpc":"2.0","id":1,"result":1}'
    const b = '{"jsonrpc":"2.0","method":"note"}'
    expect(reader.push(enc(`${a}\n\n${b}\n`))).toEqual([
      { jsonrpc: "2.0", id: 1, result: 1 },
      { jsonrpc: "2.0", method: "note" },
    ])
    expect(reader.push(enc('{"jsonrpc":"2.0",'))).toEqual([])
    expect(reader.push(enc('"id":4,"result":"split"}\n'))).toEqual([
      { jsonrpc: "2.0", id: 4, result: "split" },
    ])
  })
})
