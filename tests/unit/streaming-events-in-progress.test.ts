/**
 * ADR-0048 — `response.in_progress` SSE + WebSocket event decoding.
 *
 * Codex's WebSocket dispatcher silently drops `response.in_progress`; v3
 * surfaces it as a first-class StreamEvent so the UI can render "thinking..."
 * indicators without polling. These tests pin:
 *   (1) SSE wire shape → StreamEvent variant
 *   (2) WS envelope shape → StreamEvent variant
 *   (3) Forward-compat: unknown events still pass through gracefully
 *       (returned as `null`, not thrown) — the existing forward-compat contract
 *       is intact, with `response.in_progress` newly KNOWN.
 */
import { describe, expect, test } from "bun:test"
import { decodeSseEvent, decodeWsEvent, parseSseFrame, type StreamEvent } from "@/llm"

describe("response.in_progress — SSE decoder", () => {
  test("parses event/data lines into a frame view", () => {
    const text = 'event: response.in_progress\ndata: {"progress":0.42}'
    const frame = parseSseFrame(text)
    expect(frame).toEqual({
      event: "response.in_progress",
      data: '{"progress":0.42}',
    })
  })

  test("decodes response.in_progress SSE frame to a typed StreamEvent", () => {
    const frame = parseSseFrame(
      'event: response.in_progress\ndata: {"progress":0.5,"message":"thinking..."}',
    )
    expect(frame).not.toBeNull()
    if (frame === null) return
    const ev = decodeSseEvent(frame)
    expect(ev).toEqual({
      type: "response_in_progress",
      data: { progress: 0.5, message: "thinking..." },
    } satisfies StreamEvent)
  })

  test("empty data payload still produces a valid event (data: {})", () => {
    // SSE allows `data:` with empty payload — we want a structurally-valid
    // StreamEvent rather than skipping the frame entirely.
    const frame = parseSseFrame("event: response.in_progress\ndata: {}")
    if (frame === null) throw new Error("frame should parse")
    const ev = decodeSseEvent(frame)
    expect(ev).toEqual({ type: "response_in_progress", data: {} })
  })

  test("malformed JSON in data → falls back to empty object (forward-compat)", () => {
    const frame = parseSseFrame("event: response.in_progress\ndata: not-json{")
    if (frame === null) throw new Error("frame should parse")
    const ev = decodeSseEvent(frame)
    expect(ev).toEqual({ type: "response_in_progress", data: {} })
  })

  test("unknown event type → null (forward-compat, no throw)", () => {
    const frame = parseSseFrame('event: response.future_unknown\ndata: {"x":1}')
    if (frame === null) throw new Error("frame should parse")
    expect(decodeSseEvent(frame)).toBeNull()
  })

  test("structurally invalid frame (missing event line) → null", () => {
    expect(parseSseFrame('data: {"x":1}')).toBeNull()
  })

  test("structurally invalid frame (missing data line) → null", () => {
    expect(parseSseFrame("event: response.in_progress")).toBeNull()
  })

  test("multiline data joined with \\n per SSE spec", () => {
    const frame = parseSseFrame("event: response.in_progress\ndata: line1\ndata: line2")
    expect(frame?.data).toBe("line1\nline2")
  })
})

describe("response.in_progress — WebSocket decoder", () => {
  test("decodes envelope with kind=response.in_progress to typed StreamEvent", () => {
    const ev = decodeWsEvent({
      kind: "response.in_progress",
      progress: 0.7,
      message: "still generating",
    })
    expect(ev).toEqual({
      type: "response_in_progress",
      data: { progress: 0.7, message: "still generating" },
    } satisfies StreamEvent)
  })

  test("kind=response.in_progress with bare envelope → data is empty object", () => {
    const ev = decodeWsEvent({ kind: "response.in_progress" })
    expect(ev).toEqual({ type: "response_in_progress", data: {} })
  })

  test("unknown kind → null (forward-compat, no throw)", () => {
    expect(decodeWsEvent({ kind: "response.completed" })).toBeNull()
    expect(decodeWsEvent({ kind: "response.created" })).toBeNull()
    expect(decodeWsEvent({ kind: "response.future_unknown" })).toBeNull()
  })

  test("kind discriminator is stripped from the payload", () => {
    const ev = decodeWsEvent({ kind: "response.in_progress", extraField: "kept" })
    if (ev === null || ev.type !== "response_in_progress") {
      throw new Error("expected response_in_progress event")
    }
    expect(ev.data).not.toHaveProperty("kind")
    expect(ev.data).toEqual({ extraField: "kept" })
  })
})
