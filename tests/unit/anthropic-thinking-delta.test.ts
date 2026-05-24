/**
 * ADR-0076 Gap-2 — `thinking_delta` is now SURFACED (no longer drained) so
 * extended-thinking content can be assembled into a {@link ThinkingBlock} and
 * carried back to the provider on the next turn (signature roundtrip).
 *
 * Pre-Gap-2 the adapter silently drained the delta because Phase 1 had no way
 * to round-trip the cryptographic signature. With ThinkingBlock.signature
 * added in `src/llm/types.ts` and serialization wired in `toAnthropicContent`,
 * the drain is replaced with a structured emit.
 *
 * The test runs `mapRawEvent` directly with synthesized RawEvents covering:
 *   (a) thinking_delta only → one thinking_delta StreamEvent per raw delta
 *   (b) interleaved with text_delta → both surface, in stream order
 *   (c) thinking block start/stop pair without delta → no emit (still inert)
 *   (d) text_delta + thinking_delta sequence preserves stream ordering
 *   (e) signature_delta emits a structured StreamEvent for assembly
 *   (f) redacted_thinking start emits a redacted thinking_delta carrying the
 *       opaque ciphertext (no following deltas)
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

describe("ADR-0076 Gap-2 — thinking_delta surface", () => {
  test("thinking_delta alone → one thinking_delta StreamEvent per raw delta", () => {
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
    expect(events).toEqual([
      { type: "thinking_delta", text: "..." },
      { type: "thinking_delta", text: "more" },
    ])
  })

  test("text_delta + thinking_delta interleaved → both surface in stream order", () => {
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
    expect(events).toEqual([
      { type: "thinking_delta", text: "reason" },
      { type: "text_delta", delta: "hello" },
    ])
  })

  test("ordering preserved: text → thinking → text emits the three deltas in stream order", () => {
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
      { type: "thinking_delta", text: "noise" },
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

  test("signature_delta emits structured StreamEvent for assembly", () => {
    const events = drive([
      { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "x" } },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "sig-abc" },
      },
      { type: "content_block_stop", index: 0 },
    ] as RawEvent[])
    expect(events).toEqual([
      { type: "thinking_delta", text: "x" },
      { type: "signature_delta", signature: "sig-abc" },
    ])
  })

  test("redacted_thinking start emits one redacted thinking_delta carrying ciphertext", () => {
    const events = drive([
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "redacted_thinking", data: "ENCRYPTED_BYTES_BLOB" },
      },
      { type: "content_block_stop", index: 0 },
    ] as RawEvent[])
    expect(events).toEqual([
      { type: "thinking_delta", text: "ENCRYPTED_BYTES_BLOB", redacted: true },
    ])
  })
})
