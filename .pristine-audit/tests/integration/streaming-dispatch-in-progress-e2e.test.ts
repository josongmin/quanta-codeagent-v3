/**
 * Integration: streaming-dispatch in-progress indicator seam (ADR-0048).
 *
 * Pins the additive wiring: when the model stream yields a
 * `response_in_progress` event, the dispatcher invokes `onInProgress` with
 * the carried metadata plus a receive-side `timestamp`; when no handler is
 * registered the event is silently absorbed and assembly is byte-identical
 * to a stream that omitted the heartbeat (verified by the assemble step
 * inside `streamingTurn` returning the same message regardless).
 */
import { describe, expect, test } from "bun:test"
import { type InProgressIndicator, streamingTurn } from "@/agent/streaming-dispatch"
import type { StreamEvent } from "@/llm"

const noopDispatch = async () => {
  throw new Error("dispatch should not be called in these tests")
}

const isSafe = (): boolean => true

async function* streamOf(events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const ev of events) {
    yield ev
    await Promise.resolve()
  }
}

describe("streamingTurn — in-progress indicator seam (ADR-0048)", () => {
  test("invokes onInProgress with carried metadata + receive-side timestamp", async () => {
    const captured: InProgressIndicator[] = []
    const events: StreamEvent[] = [
      { type: "text_delta", delta: "hello " },
      {
        type: "response_in_progress",
        message: "still working",
        progress: 0.42,
        createdAt: 1700000000000,
      },
      { type: "text_delta", delta: "world" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    const result = await streamingTurn({
      events: streamOf(events),
      isConcurrencySafe: isSafe,
      dispatch: noopDispatch,
      onInProgress: (ind) => captured.push(ind),
    })
    expect(result.kind).toBe("assembled")
    expect(captured.length).toBe(1)
    expect(captured[0]).toEqual({
      kind: "in-progress",
      message: "still working",
      progress: 0.42,
      timestamp: 1700000000000,
    })
    if (result.kind === "assembled") {
      const text = result.message.content
        .filter((b) => b.type === "text")
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("")
      expect(text).toBe("hello world")
    }
  })

  test("default timestamp filled in when provider omits createdAt", async () => {
    const captured: InProgressIndicator[] = []
    const before = Date.now()
    const events: StreamEvent[] = [
      { type: "response_in_progress" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    await streamingTurn({
      events: streamOf(events),
      isConcurrencySafe: isSafe,
      dispatch: noopDispatch,
      onInProgress: (ind) => captured.push(ind),
    })
    const after = Date.now()
    expect(captured.length).toBe(1)
    const ts = captured[0]?.timestamp ?? 0
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
    // Optional fields absent ⇒ NOT present on the indicator
    expect(captured[0]).not.toHaveProperty("message")
    expect(captured[0]).not.toHaveProperty("progress")
  })

  test("no onInProgress handler → events are silently absorbed (byte-identical assembly)", async () => {
    const eventsWith: StreamEvent[] = [
      { type: "text_delta", delta: "A" },
      { type: "response_in_progress", message: "thinking" },
      { type: "text_delta", delta: "B" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    const eventsWithout: StreamEvent[] = [
      { type: "text_delta", delta: "A" },
      { type: "text_delta", delta: "B" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    const r1 = await streamingTurn({
      events: streamOf(eventsWith),
      isConcurrencySafe: isSafe,
      dispatch: noopDispatch,
    })
    const r2 = await streamingTurn({
      events: streamOf(eventsWithout),
      isConcurrencySafe: isSafe,
      dispatch: noopDispatch,
    })
    expect(r1.kind).toBe("assembled")
    expect(r2.kind).toBe("assembled")
    if (r1.kind === "assembled" && r2.kind === "assembled") {
      expect(r1.message).toEqual(r2.message)
      expect(r1.stopReason).toBe(r2.stopReason)
    }
  })
})
