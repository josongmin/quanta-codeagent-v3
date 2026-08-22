/**
 * P26 — `StreamJsonSink` machine-contract hellgate.
 *
 * Pins the headless `--output-format json|stream-json` stdout contract:
 *   (a) `stream-json` — EACH written line is valid JSON, carries the versioned
 *       session envelope, and round-trips through `decodeSessionEvent`.
 *   (b) `json` — exactly ONE well-formed top-level JSON value (an array) is
 *       written, and every element round-trips through the codec.
 *   (c) partial / streaming-delta events (`assistant_text` → `turn.output.delta`)
 *       are emitted ONLY when `includePartial` is set.
 *   (d) the versioning marker is the session-protocol envelope version.
 *   (e) NO-THROW boundary — a throwing writer never escapes `emit`/`finalize`.
 *
 * Hermetic: the sink takes injected `write` / `now` / `newId` so no real stdout,
 * clock, or UUID entropy leaks in.
 */
import { describe, expect, test } from "bun:test"
import {
  STREAM_JSON_CONTRACT_VERSION,
  StreamJsonSink,
} from "@/../src/apps/agent/mode-presets/stream-json-sink"
import { decodeSessionEvent, SESSION_PROTOCOL_VERSION, type SessionEvent } from "@/protocol/session"
import type { AgentEvent } from "@/stream"

/** Deterministic id/clock seams so envelopes are byte-stable across runs. */
const det = () => {
  let n = 0
  return {
    newId: () => `evt-${++n}`,
    now: () => new Date(1_700_000_000_000),
  }
}

const capture = () => {
  const lines: string[] = []
  return { write: (c: string) => lines.push(c), lines }
}

/** A representative milestone trajectory. */
const TRAJECTORY: AgentEvent[] = [
  { type: "session_start" },
  { type: "turn_start", turn: 1 },
  { type: "llm_request", model: "gpt-5", provider: "openai" },
  { type: "assistant_text", delta: "hello " },
  { type: "tool_call", id: "t1", name: "bash", input: { cmd: "ls" } },
  { type: "tool_result", id: "t1", name: "bash", ok: true, preview: "a\nb", durationMs: 12 },
  { type: "done", reason: "completed", turns: 1 },
]

describe("StreamJsonSink — stream-json (a) each line is valid JSON + codec round-trip", () => {
  test("every NDJSON line parses as JSON and decodes through the SessionEvent codec", () => {
    const cap = capture()
    const d = det()
    const sink = new StreamJsonSink({ format: "stream-json", write: cap.write, ...d })
    for (const e of TRAJECTORY) sink.emit(e)
    sink.finalize() // no-op in stream-json

    // assistant_text is a partial → dropped by default; the 6 milestone events remain.
    expect(cap.lines.length).toBe(6)
    const decoded: SessionEvent[] = []
    for (const line of cap.lines) {
      expect(line.endsWith("\n")).toBe(true)
      const raw = line.trimEnd()
      // (a1) independently jq-parseable: pure JSON.parse must succeed.
      const parsed = JSON.parse(raw) as { version: string; kind: string }
      // (d) versioning marker present + correct.
      expect(parsed.version).toBe(SESSION_PROTOCOL_VERSION)
      expect(parsed.kind).toBe("event")
      // (a2) full codec round-trip (validates payload shape).
      decoded.push(decodeSessionEvent(raw))
    }
    expect(decoded.map((e) => e.type)).toEqual([
      "session.created",
      "turn.started",
      "turn.llm.request",
      "tool.invoked",
      "tool.completed",
      "turn.completed",
    ])
    // seq is monotonic from 1.
    expect(decoded.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6])
  })
})

describe("StreamJsonSink — json (b) one well-formed top-level JSON value", () => {
  test("finalize writes exactly ONE array value; each element codec-round-trips", () => {
    const cap = capture()
    const d = det()
    const sink = new StreamJsonSink({ format: "json", write: cap.write, ...d })
    for (const e of TRAJECTORY) sink.emit(e)
    // Before finalize: nothing on stdout (buffered).
    expect(cap.lines.length).toBe(0)
    sink.finalize()
    // Exactly one write, one top-level JSON value.
    expect(cap.lines.length).toBe(1)
    const raw = cap.lines[0]!.trimEnd()
    const arr = JSON.parse(raw) as unknown[]
    expect(Array.isArray(arr)).toBe(true)
    expect(arr.length).toBe(6)
    // each element is itself a valid session envelope.
    for (const el of arr) {
      const reEncoded = JSON.stringify(el)
      const decoded = decodeSessionEvent(reEncoded)
      expect(decoded.eventId.startsWith("evt-")).toBe(true)
    }
  })

  test("finalize is idempotent — a double call does not double-write", () => {
    const cap = capture()
    const sink = new StreamJsonSink({ format: "json", write: cap.write, ...det() })
    sink.emit({ type: "done", reason: "completed", turns: 1 })
    sink.finalize()
    sink.finalize()
    expect(cap.lines.length).toBe(1)
  })
})

describe("StreamJsonSink — (c) partial gating", () => {
  test("assistant_text is DROPPED without includePartial", () => {
    const cap = capture()
    const sink = new StreamJsonSink({ format: "stream-json", write: cap.write, ...det() })
    sink.emit({ type: "assistant_text", delta: "x" })
    expect(cap.lines.length).toBe(0)
  })

  test("assistant_text becomes turn.output.delta WITH includePartial", () => {
    const cap = capture()
    const sink = new StreamJsonSink({
      format: "stream-json",
      includePartial: true,
      write: cap.write,
      ...det(),
    })
    sink.emit({ type: "assistant_text", delta: "x" })
    expect(cap.lines.length).toBe(1)
    const ev = decodeSessionEvent(cap.lines[0]!.trimEnd())
    expect(ev.type).toBe("turn.output.delta")
    expect((ev as { delta: string }).delta).toBe("x")
  })
})

describe("StreamJsonSink — (d) version marker + (e) no-throw boundary", () => {
  test("STREAM_JSON_CONTRACT_VERSION tracks the session-protocol version", () => {
    expect(STREAM_JSON_CONTRACT_VERSION).toBe(SESSION_PROTOCOL_VERSION)
  })

  test("a throwing writer (EPIPE) never escapes emit/finalize", () => {
    const boom = (): void => {
      throw new Error("EPIPE")
    }
    const sink = new StreamJsonSink({ format: "stream-json", write: boom, ...det() })
    expect(() => sink.emit({ type: "done", reason: "completed", turns: 1 })).not.toThrow()
    const jsonSink = new StreamJsonSink({ format: "json", write: boom, ...det() })
    jsonSink.emit({ type: "done", reason: "completed", turns: 1 })
    expect(() => jsonSink.finalize()).not.toThrow()
  })

  test("unmapped AgentEvent variants are silently dropped (no crash)", () => {
    const cap = capture()
    const sink = new StreamJsonSink({ format: "stream-json", write: cap.write, ...det() })
    sink.emit({ type: "usage", inputTokens: 1, outputTokens: 2, model: "gpt-5" })
    sink.emit({ type: "output_progress", outputTokens: 5, exact: false })
    sink.emit({ type: "in_progress", timestamp: 1 })
    expect(cap.lines.length).toBe(0)
  })
})
