/**
 * R-Phase5 P1-F regression — `thinking_delta` is DRAINED (silently) by the
 * Anthropic adapter's `mapRawEvent`. Phase 1 of the adapter intentionally
 * drops thinking blocks from the assembled message (toAnthropicContent
 * filters them out before re-sending), and no `thinking_delta` StreamEvent
 * variant exists.
 *
 * Pre-P1-F the delta fell through the unhandled-else without comment; a
 * reader had to infer the intent from upstream behavior. Post-P1-F the
 * switch is documented and any OTHER unrecognized delta type also drains
 * defensively (no throw, no emit).
 *
 * The test runs `mapRawEvent` directly with synthesized RawEvents covering:
 *   (a) thinking_delta only → zero StreamEvents emitted
 *   (b) interleaved with text_delta → text_delta emitted, thinking dropped
 *   (c) thinking block start/stop pair without delta → no emit
 *   (d) text_delta + thinking_delta sequence preserves text ordering
 */
import { describe, expect, test } from "bun:test"
import type { StreamEvent } from "@/llm"
import type { OpenSlots, RawEvent, UsageAccumulator } from "@/llm/adapters/anthropic"
import { mapRawEvent } from "@/llm/adapters/anthropic"

const drive = (raws: RawEvent[]): StreamEvent[] => {
  const open: OpenSlots = new Map()
  const usage: UsageAccumulator = {}
  const out: StreamEvent[] = []
  for (const r of raws) {
    for (const ev of mapRawEvent(r, open, usage)) out.push(ev)
  }
  return out
}

describe("R-Phase5 P1-F — thinking_delta drain", () => {
  test("thinking_delta in isolation → zero StreamEvents emitted", () => {
    const events = drive([
      { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "..." } },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "more" },
      },
      { type: "content_block_stop", index: 0 },
    ] as RawEvent[])
    expect(events).toEqual([])
  })

  test("text_delta + thinking_delta interleaved → text preserved, thinking dropped", () => {
    const events = drive([
      { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "reason" },
      },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "hello" } },
      { type: "content_block_stop", index: 1 },
    ] as RawEvent[])
    expect(events).toEqual([{ type: "text_delta", delta: "hello" }])
  })

  test("ordering preserved: text → thinking → text emits only the two text deltas in order", () => {
    const events = drive([
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "first" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "thinking" } },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "thinking_delta", thinking: "noise" },
      },
      { type: "content_block_stop", index: 1 },
      { type: "content_block_start", index: 2, content_block: { type: "text" } },
      { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "second" } },
      { type: "content_block_stop", index: 2 },
    ] as RawEvent[])
    expect(events).toEqual([
      { type: "text_delta", delta: "first" },
      { type: "text_delta", delta: "second" },
    ])
  })

  test("thinking block start/stop with no delta in between → no emit, no error", () => {
    const events = drive([
      { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      { type: "content_block_stop", index: 0 },
    ] as RawEvent[])
    expect(events).toEqual([])
  })
})
