import { describe, expect, test } from "bun:test"
import type { StreamEvent } from "@/llm"
import { assembleFromEvents, hasToolUse } from "@/llm"

describe("assembleFromEvents", () => {
  test("merges consecutive text deltas into one block", () => {
    const events: StreamEvent[] = [
      { type: "text_delta", delta: "Hel" },
      { type: "text_delta", delta: "lo" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    const { message, stopReason } = assembleFromEvents(events)
    expect(message.content).toEqual([{ type: "text", text: "Hello" }])
    expect(stopReason).toBe("end_turn")
    expect(hasToolUse(message)).toBe(false)
  })

  test("captures tool_use with parsed input", () => {
    const events: StreamEvent[] = [
      { type: "tool_use_start", id: "t1", name: "read" },
      { type: "tool_use_delta", id: "t1", delta: '{"path":' },
      { type: "tool_use_delta", id: "t1", delta: '"a.ts"}' },
      { type: "tool_use_end", id: "t1", input: { path: "a.ts" } },
      { type: "message_stop", stop_reason: "tool_use" },
    ]
    const { message } = assembleFromEvents(events)
    expect(hasToolUse(message)).toBe(true)
    expect(message.content[0]).toEqual({
      type: "tool_use",
      id: "t1",
      name: "read",
      input: { path: "a.ts" },
    })
  })
})
