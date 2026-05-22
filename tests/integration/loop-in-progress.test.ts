/**
 * Integration (ADR-0048 L4 wire): the agent loop now wires `onInProgress` into
 * its `streamingTurn(...)` call. When the model stream yields a
 * `response_in_progress` event, the loop emits an `in_progress` AgentEvent on
 * `config.stream` carrying the receive-side `timestamp` plus the optional
 * provider-supplied `message`/`progress`.
 *
 * Pins:
 *  - the event round-trips end-to-end (FakeLLM heartbeat → RecordingStream),
 *  - the optional fields are conditionally present (exact-optional spread),
 *  - a turn WITHOUT a heartbeat emits NO `in_progress` event (byte-identical /
 *    default-OFF when the provider stays silent).
 */
import { describe, expect, test } from "bun:test"
import { runAgent } from "@/agent"
import type { StreamEvent } from "@/llm"
import { FakeLLM, baseConfig, RecordingStream } from "./_harness"

const heartbeatTurn = (createdAt: number): StreamEvent[] => [
  { type: "text_delta", delta: "thinking " },
  { type: "response_in_progress", message: "still working", progress: 0.42, createdAt },
  { type: "text_delta", delta: "done" },
  { type: "message_stop", stop_reason: "end_turn" },
]

describe("agent loop — in_progress heartbeat wire (ADR-0048)", () => {
  test("response_in_progress → in_progress AgentEvent round-trips with metadata", async () => {
    const stream = new RecordingStream()
    const llm = new FakeLLM([heartbeatTurn(1700000000000)])
    const outcome = await runAgent(baseConfig({ llm, stream }))

    expect(outcome.reason).toBe("completed")
    const hb = stream.events.filter((e) => e.type === "in_progress")
    expect(hb.length).toBe(1)
    expect(hb[0]).toEqual({
      type: "in_progress",
      timestamp: 1700000000000,
      message: "still working",
      progress: 0.42,
    })
  })

  test("provider omits createdAt → receive-side timestamp filled; optional fields absent", async () => {
    const stream = new RecordingStream()
    const before = Date.now()
    const llm = new FakeLLM([
      [
        { type: "response_in_progress" },
        { type: "text_delta", delta: "ok" },
        { type: "message_stop", stop_reason: "end_turn" },
      ],
    ])
    await runAgent(baseConfig({ llm, stream }))
    const after = Date.now()

    const hb = stream.events.filter((e) => e.type === "in_progress")
    expect(hb.length).toBe(1)
    const ev = hb[0]
    if (ev?.type !== "in_progress") throw new Error("expected in_progress")
    expect(ev.timestamp).toBeGreaterThanOrEqual(before)
    expect(ev.timestamp).toBeLessThanOrEqual(after)
    expect(ev).not.toHaveProperty("message")
    expect(ev).not.toHaveProperty("progress")
  })

  test("no heartbeat in the stream → no in_progress event emitted", async () => {
    const stream = new RecordingStream()
    const llm = new FakeLLM([
      [
        { type: "text_delta", delta: "plain" },
        { type: "message_stop", stop_reason: "end_turn" },
      ],
    ])
    await runAgent(baseConfig({ llm, stream }))
    expect(stream.events.some((e) => e.type === "in_progress")).toBe(false)
  })
})
