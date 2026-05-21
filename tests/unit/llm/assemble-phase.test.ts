/**
 * ADR-0077 — `determinePhases` post-pass on `assembleFromEvents`.
 *
 * Pins the STRUCTURAL phase marker contract: every {@link TextBlock} in the
 * assembled assistant message is tagged `commentary` IFF there is at least one
 * `tool_use` block AFTER it (in `content[]` index order), else `final_answer`.
 * Deterministic single backward scan; no heuristics.
 */
import { describe, expect, test } from "bun:test"
import type { ContentBlock, StreamEvent, TextBlock } from "@/llm"
import { assembleFromEvents, determinePhases } from "@/llm"

const textPhases = (content: ContentBlock[]): (string | undefined)[] =>
  content.filter((b): b is TextBlock => b.type === "text").map((b) => b.phase)

describe("ADR-0077 — determinePhases post-pass via assembleFromEvents", () => {
  test("[text] → single block tagged final_answer", () => {
    const events: StreamEvent[] = [
      { type: "text_delta", delta: "all done" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    const { message } = assembleFromEvents(events)
    expect(message.content).toEqual([{ type: "text", text: "all done", phase: "final_answer" }])
  })

  test("[text, tool_use] → text before a tool is commentary", () => {
    const events: StreamEvent[] = [
      { type: "text_delta", delta: "let me look this up" },
      { type: "tool_use_start", id: "t1", name: "read" },
      { type: "tool_use_end", id: "t1", input: { path: "a.ts" } },
      { type: "message_stop", stop_reason: "tool_use" },
    ]
    const { message } = assembleFromEvents(events)
    expect(textPhases(message.content)).toEqual(["commentary"])
    expect(message.content[0]).toMatchObject({
      type: "text",
      text: "let me look this up",
      phase: "commentary",
    })
  })

  test("[text, tool_use, text] → commentary then final_answer", () => {
    const events: StreamEvent[] = [
      { type: "text_delta", delta: "first thought" },
      { type: "tool_use_start", id: "t1", name: "read" },
      { type: "tool_use_end", id: "t1", input: { path: "a.ts" } },
      { type: "text_delta", delta: "here is the answer" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    const { message } = assembleFromEvents(events)
    expect(textPhases(message.content)).toEqual(["commentary", "final_answer"])
  })

  test("[text, tool_use, text, tool_use] → every text is commentary (trailing tool_use exists)", () => {
    const events: StreamEvent[] = [
      { type: "text_delta", delta: "first" },
      { type: "tool_use_start", id: "t1", name: "read" },
      { type: "tool_use_end", id: "t1", input: { path: "a.ts" } },
      { type: "text_delta", delta: "second" },
      { type: "tool_use_start", id: "t2", name: "read" },
      { type: "tool_use_end", id: "t2", input: { path: "b.ts" } },
      { type: "message_stop", stop_reason: "tool_use" },
    ]
    const { message } = assembleFromEvents(events)
    expect(textPhases(message.content)).toEqual(["commentary", "commentary"])
  })
})

describe("ADR-0077 — determinePhases helper (pure, idempotent)", () => {
  test("empty content array — no-op", () => {
    const content: ContentBlock[] = []
    determinePhases(content)
    expect(content).toEqual([])
  })

  test("non-text blocks pass through untouched", () => {
    const content: ContentBlock[] = [
      { type: "tool_use", id: "x", name: "read", input: {} },
      { type: "thinking", thinking: "hmm" },
    ]
    determinePhases(content)
    expect(content).toEqual([
      { type: "tool_use", id: "x", name: "read", input: {} },
      { type: "thinking", thinking: "hmm" },
    ])
  })

  test("idempotent — running twice yields identical tags", () => {
    const content: ContentBlock[] = [
      { type: "text", text: "a" },
      { type: "tool_use", id: "x", name: "read", input: {} },
      { type: "text", text: "b" },
    ]
    determinePhases(content)
    const first = JSON.parse(JSON.stringify(content))
    determinePhases(content)
    expect(content).toEqual(first)
  })
})
