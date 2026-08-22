/**
 * Unit tests for `src/llm/streaming-events.ts` (ADR-0048).
 *
 * Coverage matrix (10 tests):
 *   1. SSE fragmented frames (small chunks reassemble via splitSseFrames)
 *   2. SSE CRLF vs LF line endings both decode identically
 *   3. SSE multi-line `data:` fields concatenate with "\n" (spec §9.2)
 *   4. SSE missing `data:` → null
 *   5. SSE 1MB+ payload survives intact
 *   6. WS BOM-prefixed JSON decodes
 *   7. WS malformed JSON → null + debug log (no throw)
 *   8. WS deeply nested data preserved
 *   9. Forward-compat: unknown event → kind="unknown" carrying raw vocabulary
 *  10. Rate-limit smoke: 1000 unknown events log at most 10 lines / window
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  __resetUnknownEventRateLimitForTests,
  decodeSseEvent,
  decodeWsEvent,
  logUnknownEventRateLimited,
  parseSseFrame,
  splitSseFrames,
} from "@/llm"

beforeEach(() => {
  __resetUnknownEventRateLimitForTests()
})

afterEach(() => {
  __resetUnknownEventRateLimitForTests()
})

describe("streaming-events: SSE parsing robustness", () => {
  test("1. fragmented frames reassemble through splitSseFrames remainder", () => {
    // Two complete frames + a fragment, fed in 5 small chunks.
    const full =
      'event: response.in_progress\ndata: {"type":"response.in_progress","message":"thinking"}\n\n' +
      'event: response.created\ndata: {"type":"response.created"}\n\n' +
      "event: response.in_pro"
    // chunk it into 5 random-ish slices to model TCP reads
    const chunks = [
      full.slice(0, 20),
      full.slice(20, 60),
      full.slice(60, 100),
      full.slice(100, 160),
      full.slice(160),
    ]
    let buf = ""
    const allFrames: Array<{ name: string; data: string }> = []
    for (const c of chunks) {
      buf += c
      const { frames, remainder } = splitSseFrames(buf)
      allFrames.push(...frames)
      buf = remainder
    }
    expect(allFrames.length).toBe(2)
    expect(allFrames[0]?.name).toBe("response.in_progress")
    const decoded0 = decodeSseEvent(allFrames[0] as { name: string; data: string })
    expect(decoded0?.kind).toBe("response.in_progress")
    expect((decoded0?.data as { message?: string })?.message).toBe("thinking")
    expect(allFrames[1]?.name).toBe("response.created")
    // remainder must still hold the fragment for the next round
    expect(buf.startsWith("event: response.in_pro")).toBe(true)
  })

  test("2. CRLF vs LF line endings produce identical parse output", () => {
    const lf = 'event: response.in_progress\ndata: {"type":"response.in_progress","progress":0.5}'
    const crlf = lf.replace(/\n/g, "\r\n")
    const a = parseSseFrame(lf)
    const b = parseSseFrame(crlf)
    expect(a).toEqual(b)
    expect(a?.name).toBe("response.in_progress")
    expect(a?.data).toContain('"progress":0.5')
  })

  test("3. multi-line `data:` fields concatenate with newline per spec", () => {
    // Two data lines whose concatenation forms a valid JSON object.
    const block =
      'event: response.in_progress\ndata: {"type":"response.in_progress",\ndata: "message":"pondering"}'
    const parsed = parseSseFrame(block)
    expect(parsed?.data).toBe('{"type":"response.in_progress",\n"message":"pondering"}')
    const decoded = decodeSseEvent(parsed as { name: string; data: string })
    expect(decoded?.kind).toBe("response.in_progress")
    expect((decoded?.data as { message?: string })?.message).toBe("pondering")
  })

  test("4. missing `data:` line → parseSseFrame returns null (no throw)", () => {
    expect(parseSseFrame("event: response.in_progress")).toBeNull()
    expect(parseSseFrame(": just a comment")).toBeNull()
    expect(parseSseFrame("")).toBeNull()
  })

  test("4b. lone-CR chunk boundary inside a multi-line event does NOT split it", () => {
    // A single CRLF-terminated event whose JSON spans TWO `data:` lines. Chunk
    // the byte stream so chunk1 ends on the lone `\r` that terminates the FIRST
    // `data:` line and chunk2 opens with the matching `\n`. A naive
    // normalize-then-split converts the stray `\r` to `\n`; the next chunk's
    // `\n` then forms a spurious `\n\n`, splitting one event into two frames and
    // corrupting the JSON (`{"a":1,` + `"b":2}`). The carry-the-CR fix keeps the
    // CRLF intact so the event reassembles into ONE valid frame.
    const full =
      'event: response.in_progress\r\ndata: {"type":"response.in_progress",\r\ndata: "message":"a"}\r\n\r\n'
    const splitAt = full.indexOf('",\r') + 3 // just past the lone `\r` of the first data line
    const chunks = [full.slice(0, splitAt), full.slice(splitAt)]
    expect(chunks[0]?.endsWith("\r")).toBe(true) // precondition: split lands on lone CR
    let buf = ""
    const allFrames: Array<{ name: string; data: string }> = []
    for (const c of chunks) {
      buf += c
      const { frames, remainder } = splitSseFrames(buf)
      allFrames.push(...frames)
      buf = remainder
    }
    // Exactly ONE frame — the bug yields two (corrupt JSON + orphan fragment).
    expect(allFrames.length).toBe(1)
    expect(allFrames[0]?.name).toBe("response.in_progress")
    const decoded = decodeSseEvent(allFrames[0] as { name: string; data: string })
    expect(decoded?.kind).toBe("response.in_progress")
    expect((decoded?.data as { message?: string })?.message).toBe("a")
  })

  test("5. >=1MB data payload survives parse + decode intact", () => {
    const big = "x".repeat(1_048_576) // 1 MiB
    const obj = { type: "response.in_progress", message: big }
    const block = `event: response.in_progress\ndata: ${JSON.stringify(obj)}`
    const parsed = parseSseFrame(block)
    expect(parsed?.data.length).toBeGreaterThan(1_048_576)
    const decoded = decodeSseEvent(parsed as { name: string; data: string })
    expect(decoded?.kind).toBe("response.in_progress")
    expect((decoded?.data as { message?: string })?.message?.length).toBe(1_048_576)
  })
})

describe("streaming-events: WebSocket robustness", () => {
  test("6. BOM-prefixed WS JSON decodes (kind preserved)", () => {
    const bom = "﻿"
    const raw = `${bom}{"kind":"response.in_progress","progress":0.25}`
    const decoded = decodeWsEvent(raw)
    expect(decoded?.kind).toBe("response.in_progress")
    expect((decoded?.data as { progress?: number })?.progress).toBe(0.25)
  })

  test("7. malformed WS JSON returns null without throwing", () => {
    expect(decodeWsEvent('{"kind": "response.in_progress",}')).toBeNull() // trailing comma
    expect(decodeWsEvent("not json at all")).toBeNull()
    expect(decodeWsEvent("")).toBeNull()
    expect(decodeWsEvent("   ")).toBeNull()
  })

  test("8. deeply nested WS data preserved", () => {
    const nested = {
      kind: "response.in_progress",
      message: "deep",
      meta: { a: { b: { c: { d: { e: "leaf" } } } } },
    }
    const decoded = decodeWsEvent(JSON.stringify(nested))
    expect(decoded?.kind).toBe("response.in_progress")
    expect(
      (decoded?.data as { meta: { a: { b: { c: { d: { e: string } } } } } }).meta.a.b.c.d.e,
    ).toBe("leaf")
  })
})

describe("streaming-events: forward-compat unknown events", () => {
  test("9. unknown event vocabulary surfaces as kind='unknown' carrying rawKind", () => {
    const raw = JSON.stringify({ kind: "response.something.brand.new", payload: 42 })
    const decoded = decodeWsEvent(raw)
    expect(decoded?.kind).toBe("unknown")
    if (decoded?.kind === "unknown") {
      expect(decoded.rawKind).toBe("response.something.brand.new")
      expect(decoded.data.payload).toBe(42)
    }
    // Same path via SSE
    const sseBlock = `event: response.weird\ndata: ${raw}`
    const parsed = parseSseFrame(sseBlock)
    const decodedSse = decodeSseEvent(parsed as { name: string; data: string })
    expect(decodedSse?.kind).toBe("unknown")
  })

  test("10. rate-limit smoke: 1000 unknown events bounded to LIMIT emissions per window", () => {
    // Fixed clock — every call within the same window so the limiter caps.
    const fixedNow = () => 1_000_000
    const ev = {
      kind: "unknown" as const,
      rawKind: "response.spam",
      data: {} as Record<string, unknown>,
    }
    let emitted = 0
    for (let i = 0; i < 1000; i++) {
      if (logUnknownEventRateLimited(ev, fixedNow)) emitted++
    }
    // LIMIT=10 lines per window; after 1000 calls within a single window
    // we must see exactly LIMIT emissions — the other 990 are dropped.
    expect(emitted).toBe(10)
    // Window advance ⇒ next call emits again (proves the limiter resets).
    const laterNow = () => 1_000_000 + 60_001
    expect(logUnknownEventRateLimited(ev, laterNow)).toBe(true)
  })
})
