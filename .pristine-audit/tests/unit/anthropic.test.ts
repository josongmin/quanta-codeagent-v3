import { describe, expect, test } from "bun:test"
import type { LLMPort, StreamEvent } from "@/llm"
import { assembleFromEvents } from "@/llm"
import type { OpenSlots, RawEvent } from "@/llm/adapters/anthropic"
import { AnthropicAdapter, finalizeToolInput, mapRawEvent } from "@/llm/adapters/anthropic"
import { LLMError } from "@/shared"

/** Drive a sequence of raw SSE events through `mapRawEvent` with a shared
 *  open-slots map, exactly as `AnthropicAdapter.stream` does. */
const drive = (events: RawEvent[]): StreamEvent[] => {
  const open: OpenSlots = new Map()
  const out: StreamEvent[] = []
  for (const ev of events) {
    for (const mapped of mapRawEvent(ev, open)) out.push(mapped)
  }
  return out
}

describe("mapRawEvent — text streaming", () => {
  test("start(text) + multiple text_delta + stop ⇒ text_delta events", () => {
    const out = drive([
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
      { type: "content_block_stop", index: 0 },
    ])
    expect(out).toEqual([
      { type: "text_delta", delta: "Hel" },
      { type: "text_delta", delta: "lo" },
    ])
  })

  test("text content_block_stop emits nothing and clears the slot", () => {
    const open: OpenSlots = new Map()
    const events: RawEvent[] = [
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_stop", index: 0 },
    ]
    const out: StreamEvent[] = []
    for (const ev of events) {
      for (const mapped of mapRawEvent(ev, open)) out.push(mapped)
    }
    expect(out).toEqual([])
    expect(open.size).toBe(0)
  })
})

describe("mapRawEvent — tool_use", () => {
  test("start ⇒ tool_use_start, json deltas ⇒ tool_use_delta, stop ⇒ tool_use_end", () => {
    const out = drive([
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tu_1", name: "read" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"path":' },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '"a.ts"}' },
      },
      { type: "content_block_stop", index: 0 },
    ])
    expect(out).toEqual([
      { type: "tool_use_start", id: "tu_1", name: "read" },
      { type: "tool_use_delta", id: "tu_1", delta: '{"path":' },
      { type: "tool_use_delta", id: "tu_1", delta: '"a.ts"}' },
      { type: "tool_use_end", id: "tu_1", input: { path: "a.ts" } },
    ])
  })

  test("empty json ⇒ input {}", () => {
    const out = drive([
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tu_2", name: "noargs" },
      },
      { type: "content_block_stop", index: 0 },
    ])
    expect(out).toEqual([
      { type: "tool_use_start", id: "tu_2", name: "noargs" },
      { type: "tool_use_end", id: "tu_2", input: {} },
    ])
  })

  test("malformed json ⇒ throws LLMError with the tool id in the message", () => {
    const open: OpenSlots = new Map()
    for (const _ of mapRawEvent(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tu_bad", name: "x" },
      },
      open,
    )) {
      // drain
    }
    for (const _ of mapRawEvent(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{ not json" },
      },
      open,
    )) {
      // drain
    }
    expect(() => {
      for (const _ of mapRawEvent({ type: "content_block_stop", index: 0 }, open)) {
        // drain
      }
    }).toThrow(LLMError)
    try {
      const o2: OpenSlots = new Map()
      for (const _ of mapRawEvent(
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "tu_bad", name: "x" },
        },
        o2,
      )) {
        // drain
      }
      for (const _ of mapRawEvent(
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: "{bad" },
        },
        o2,
      )) {
        // drain
      }
      for (const _ of mapRawEvent({ type: "content_block_stop", index: 0 }, o2)) {
        // drain
      }
      throw new Error("expected throw")
    } catch (e) {
      expect(e).toBeInstanceOf(LLMError)
      expect((e as LLMError).message).toContain("tu_bad")
    }
  })

  test("input_json_delta for an unknown index emits nothing", () => {
    const out = drive([
      {
        type: "content_block_delta",
        index: 9,
        delta: { type: "input_json_delta", partial_json: "{}" },
      },
    ])
    expect(out).toEqual([])
  })
})

describe("finalizeToolInput", () => {
  test("blank/whitespace ⇒ {}", () => {
    expect(finalizeToolInput("", "id")).toEqual({})
    expect(finalizeToolInput("   \n\t", "id")).toEqual({})
  })

  test("valid JSON ⇒ parsed value", () => {
    expect(finalizeToolInput('{"a":1,"b":["x"]}', "id")).toEqual({ a: 1, b: ["x"] })
  })

  test("malformed ⇒ LLMError naming the id", () => {
    expect(() => finalizeToolInput("{nope", "tu_z")).toThrow(LLMError)
    try {
      finalizeToolInput("{nope", "tu_z")
    } catch (e) {
      expect((e as LLMError).message).toContain("tu_z")
    }
  })
})

describe("mapRawEvent — message_delta / interleave", () => {
  test("message_delta with stop_reason ⇒ message_stop with that reason", () => {
    const out = drive([{ type: "message_delta", delta: { stop_reason: "tool_use" } }])
    expect(out).toEqual([{ type: "message_stop", stop_reason: "tool_use" }])
  })

  test("message_delta with null stop_reason ⇒ no event", () => {
    const out = drive([{ type: "message_delta", delta: { stop_reason: null } }])
    expect(out).toEqual([])
  })

  test("ignored event kinds (message_start/ping/message_stop) emit nothing", () => {
    const out = drive([{ type: "message_start" }, { type: "ping" }, { type: "message_stop" }])
    expect(out).toEqual([])
  })

  test("text then tool_use interleave across distinct indexes", () => {
    const out = drive([
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok " } },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "tu_9", name: "grep" },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"q":"x"}' },
      },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
    ])
    expect(out).toEqual([
      { type: "text_delta", delta: "ok " },
      { type: "tool_use_start", id: "tu_9", name: "grep" },
      { type: "tool_use_delta", id: "tu_9", delta: '{"q":"x"}' },
      { type: "tool_use_end", id: "tu_9", input: { q: "x" } },
      { type: "message_stop", stop_reason: "tool_use" },
    ])
  })
})

describe("mapping ↔ assembly contract", () => {
  test("produced events assemble into the expected Message", () => {
    const out = drive([
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Calling " } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "tool" } },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "tu_a", name: "read" },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"path"' },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: ':"f.ts"}' },
      },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
    ])
    const { message, stopReason } = assembleFromEvents(out)
    expect(stopReason).toBe("tool_use")
    expect(message).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Calling tool", phase: "commentary" },
        { type: "tool_use", id: "tu_a", name: "read", input: { path: "f.ts" } },
      ],
    })
  })
})

describe("AnthropicAdapter — LLMPort.model", () => {
  test("exposes the configured model id as a readable .model", () => {
    const adapter = new AnthropicAdapter({ apiKey: "test-key", model: "claude-sonnet-4-6" })
    expect(adapter.model).toBe("claude-sonnet-4-6")
  })

  test("instance is assignable to LLMPort with .model readable", () => {
    const port: LLMPort = new AnthropicAdapter({ apiKey: "test-key", model: "claude-opus-4-7" })
    expect(port.model).toBe("claude-opus-4-7")
  })
})
