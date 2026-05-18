import { describe, expect, test } from "bun:test"
import type { AgentEvent } from "@/stream"
import { SseStream } from "@/stream"

const makeSink = () => {
  const frames: string[] = []
  return { frames, write: (chunk: string) => frames.push(chunk) }
}

const allEvents: AgentEvent[] = [
  { type: "turn_start", turn: 1 },
  { type: "assistant_text", delta: "hello world" },
  { type: "tool_call", id: "t1", name: "read", input: { path: "/x" } },
  { type: "tool_progress", id: "t1", name: "read", message: "reading…" },
  { type: "tool_result", id: "t1", name: "read", ok: true, preview: "ok" },
  { type: "error", message: "boom" },
  { type: "done", reason: "stop", turns: 3 },
]

/** Parse a single SSE frame into its id / event / joined-data parts. */
const parseFrame = (frame: string) => {
  expect(frame.endsWith("\n\n")).toBe(true)
  const lines = frame.slice(0, -2).split("\n")
  const idLine = lines.find((l) => l.startsWith("id: "))
  const eventLine = lines.find((l) => l.startsWith("event: "))
  const data = lines
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice("data: ".length))
    .join("\n")
  return {
    id: idLine === undefined ? undefined : Number(idLine.slice("id: ".length)),
    event: eventLine?.slice("event: ".length),
    data,
  }
}

describe("SseStream", () => {
  test("each AgentEvent variant produces a spec-correct frame", () => {
    const sink = makeSink()
    const stream = new SseStream(sink)
    for (const event of allEvents) stream.emit(event)

    expect(sink.frames).toHaveLength(allEvents.length)
    sink.frames.forEach((frame, i) => {
      const original = allEvents[i]
      if (original === undefined) throw new Error("missing event")
      const { event, data } = parseFrame(frame)
      expect(event).toBe(original.type)
      expect(JSON.parse(data)).toEqual(original)
    })
  })

  test("ids are monotonically increasing from 0", () => {
    const sink = makeSink()
    const stream = new SseStream(sink)
    for (const event of allEvents) stream.emit(event)

    const ids = sink.frames.map((f) => parseFrame(f).id)
    expect(ids).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  test("JSON.stringify yields a single-line data payload (no raw newline)", () => {
    const sink = makeSink()
    const stream = new SseStream(sink)
    stream.emit({ type: "assistant_text", delta: "line1\nline2\ttab" })

    const frame = sink.frames[0]
    if (frame === undefined) throw new Error("no frame")
    const dataLineCount = frame.split("\n").filter((l) => l.startsWith("data: ")).length
    expect(dataLineCount).toBe(1)
    const { data } = parseFrame(frame)
    expect(JSON.parse(data)).toEqual({
      type: "assistant_text",
      delta: "line1\nline2\ttab",
    })
  })

  test("defensive splitter: an embedded newline becomes multiple data lines", () => {
    // comment() routes arbitrary text through the same splitter as emit();
    // a literal LF must yield multiple field lines per the SSE spec.
    const sink = makeSink()
    const stream = new SseStream(sink)
    stream.comment("first\nsecond")

    const frame = sink.frames[0]
    if (frame === undefined) throw new Error("no frame")
    expect(frame).toBe(": first\n: second\n\n")
  })

  test("comment() emits a keepalive comment line", () => {
    const sink = makeSink()
    const stream = new SseStream(sink)
    stream.comment("keepalive")

    expect(sink.frames).toEqual([": keepalive\n\n"])
  })

  test("after close() emit() and comment() are silent no-ops", () => {
    const sink = makeSink()
    const stream = new SseStream(sink)
    stream.emit({ type: "turn_start", turn: 1 })
    stream.close()
    stream.emit({ type: "done", reason: "stop", turns: 1 })
    stream.comment("late")

    expect(sink.frames).toHaveLength(1)
    expect(parseFrame(sink.frames[0] ?? "").event).toBe("turn_start")
  })

  test("close() is idempotent", () => {
    const sink = makeSink()
    const stream = new SseStream(sink)
    stream.close()
    stream.close()
    stream.emit({ type: "error", message: "x" })
    expect(sink.frames).toHaveLength(0)
  })

  test("injected clock drives timestamp() deterministically", () => {
    const sink = makeSink()
    const stream = new SseStream(sink, { now: () => 42 })
    expect(stream.timestamp()).toBe(42)
  })
})
