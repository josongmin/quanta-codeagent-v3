/**
 * ADR-0076 Gap-2 — Anthropic adapter extended-thinking SSE → StreamEvent +
 * carry-over serialization.
 *
 * Pins:
 *   - `thinking_delta` raw SSE → structured `thinking_delta` StreamEvent
 *   - `signature_delta` raw SSE → structured `signature_delta` StreamEvent
 *   - `redacted_thinking` block start → one redacted `thinking_delta` carrying
 *     the opaque ciphertext (no following deltas)
 *   - Carry-over: a fully-assembled ThinkingBlock with `signature` serializes
 *     back to the Anthropic ContentBlockParam wire shape (`thinking` +
 *     `signature`) so a multi-turn request keeps extended-thinking context
 *   - Carry-over: a redacted block serializes as `redacted_thinking` with
 *     `data` carrying the original ciphertext
 *   - Byte-identical: with no thinking budget and no thinking events, the
 *     adapter emits the exact same StreamEvent stream as before Gap-2.
 */

import { describe, expect, test } from "bun:test"
import type Anthropic from "@anthropic-ai/sdk"
import type { OpenSlots, RawEvent, UsageAccumulator } from "@/llm/adapters/anthropic"
import { AnthropicAdapter, mapRawEvent } from "@/llm/adapters/anthropic"
import { assembleFromEvents } from "@/llm/assemble"
import type { ContentBlock, Message, StreamEvent, StreamInput } from "@/llm/types"

const drive = (raws: RawEvent[]): StreamEvent[] => {
  const open: OpenSlots = new Map()
  const usage: UsageAccumulator = {}
  const out: StreamEvent[] = []
  for (const r of raws) {
    for (const ev of mapRawEvent(r, open, usage)) out.push(ev)
  }
  return out
}

describe("ADR-0076 Gap-2 — Anthropic adapter SSE → StreamEvent", () => {
  test("thinking_delta raw SSE → structured thinking_delta StreamEvent", () => {
    const events = drive([
      { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "deep thought" },
      },
    ] as RawEvent[])
    expect(events).toEqual([{ type: "thinking_delta", text: "deep thought" }])
  })

  test("signature_delta raw SSE → structured signature_delta StreamEvent", () => {
    const events = drive([
      { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "x" } },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "SIG_VALUE" },
      },
      { type: "content_block_stop", index: 0 },
    ] as RawEvent[])
    expect(events).toEqual([
      { type: "thinking_delta", text: "x" },
      { type: "signature_delta", signature: "SIG_VALUE" },
    ])
  })

  // NOTE: redacted_thinking SSE cases (single block, interleaved-with-plaintext)
  // and the byte-identical no-thinking-events case are covered by the hell-gate
  // superset (anthropic-thinking-hell.test.ts: H-2 / H-2c, and the ROUND
  // zero-thinking byte-identical test). Deleted here to avoid duplication.

  test("StreamInput.thinking undefined → adapter never sends thinking param to SDK", async () => {
    // Stub the SDK client and capture the create() payload.
    const a = new AnthropicAdapter({ apiKey: "k", model: "claude-test" })
    let capturedBody: Record<string, unknown> | undefined
    // biome-ignore lint/suspicious/noExplicitAny: test-double seam
    ;(a as any).client = {
      messages: {
        create: async (body: Record<string, unknown>) => {
          capturedBody = body
          // Return a minimal async iterable so the consumer terminates cleanly.
          return {
            async *[Symbol.asyncIterator]() {
              yield {
                type: "message_delta",
                delta: { stop_reason: "end_turn" },
              } as RawEvent
            },
          }
        },
      },
    }
    const input: StreamInput = {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [],
    }
    const out: StreamEvent[] = []
    for await (const ev of a.stream(input)) out.push(ev)
    expect(capturedBody).toBeDefined()
    expect(capturedBody && "thinking" in capturedBody).toBe(false)
  })

  test("StreamInput.thinking set → adapter forwards budget to SDK verbatim", async () => {
    const a = new AnthropicAdapter({ apiKey: "k", model: "claude-test" })
    let capturedBody: Record<string, unknown> | undefined
    // biome-ignore lint/suspicious/noExplicitAny: test-double seam
    ;(a as any).client = {
      messages: {
        create: async (body: Record<string, unknown>) => {
          capturedBody = body
          return {
            async *[Symbol.asyncIterator]() {
              yield {
                type: "message_delta",
                delta: { stop_reason: "end_turn" },
              } as RawEvent
            },
          }
        },
      },
    }
    const input: StreamInput = {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [],
      thinking: { type: "enabled", budget_tokens: 4096 },
    }
    const out: StreamEvent[] = []
    for await (const ev of a.stream(input)) out.push(ev)
    expect(capturedBody?.thinking).toEqual({ type: "enabled", budget_tokens: 4096 })
  })
})

describe("ADR-0076 Gap-2 — Anthropic carry-over serialization", () => {
  /** Stub the SDK client and capture the messages payload from create(). */
  const adapterWithCapture = (): {
    adapter: AnthropicAdapter
    captured: { body?: Record<string, unknown> }
  } => {
    const adapter = new AnthropicAdapter({ apiKey: "k", model: "claude-test" })
    const captured: { body?: Record<string, unknown> } = {}
    // biome-ignore lint/suspicious/noExplicitAny: test-double seam
    ;(adapter as any).client = {
      messages: {
        create: async (body: Record<string, unknown>) => {
          captured.body = body
          return {
            async *[Symbol.asyncIterator]() {
              yield {
                type: "message_delta",
                delta: { stop_reason: "end_turn" },
              } as RawEvent
            },
          }
        },
      },
    }
    return { adapter, captured }
  }

  const lastMessageContent = (
    body: Record<string, unknown> | undefined,
  ): Anthropic.ContentBlockParam[] => {
    const msgs = body?.messages as Anthropic.MessageParam[] | undefined
    expect(msgs).toBeDefined()
    if (!msgs) throw new Error("unreachable")
    const last = msgs[msgs.length - 1]
    expect(last).toBeDefined()
    if (!last) throw new Error("unreachable")
    if (typeof last.content === "string") throw new Error("expected content blocks")
    return last.content as Anthropic.ContentBlockParam[]
  }

  test("ThinkingBlock with signature serializes as thinking ContentBlockParam", async () => {
    const { adapter, captured } = adapterWithCapture()
    const prior: Message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "I considered the options.", signature: "SIGVAL" },
        { type: "text", text: "answer" },
      ],
    }
    const input: StreamInput = {
      messages: [
        { role: "user", content: [{ type: "text", text: "q1" }] },
        prior,
        { role: "user", content: [{ type: "text", text: "q2" }] },
      ],
      tools: [],
    }
    for await (const _ of adapter.stream(input)) {
      // drain
    }
    const msgs = captured.body?.messages as Anthropic.MessageParam[]
    const assistantBlocks = msgs[1]?.content as Anthropic.ContentBlockParam[]
    expect(assistantBlocks[0]).toEqual({
      type: "thinking",
      thinking: "I considered the options.",
      signature: "SIGVAL",
    } as Anthropic.ThinkingBlockParam)
  })

  // NOTE: "ThinkingBlock WITHOUT signature is dropped (legacy/disabled-budget
  // guard)" is covered by the hell-gate superset (anthropic-thinking-hell:
  // H-6 same setup+assertions, plus H-6b only-thinking variant). Deleted here.

  test("redacted ThinkingBlock serializes as redacted_thinking ContentBlockParam", async () => {
    const { adapter, captured } = adapterWithCapture()
    const prior: Message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "OPAQUE_BYTES", redacted: true },
        { type: "text", text: "ok" },
      ],
    }
    const input: StreamInput = {
      messages: [prior, { role: "user", content: [{ type: "text", text: "go on" }] }],
      tools: [],
    }
    for await (const _ of adapter.stream(input)) {
      // drain
    }
    const blocks = lastMessageContent(captured.body)
    // The redacted block lives on the assistant message (index 0), not the
    // trailing user message.
    const msgs = captured.body?.messages as Anthropic.MessageParam[]
    const assistantBlocks = msgs[0]?.content as Anthropic.ContentBlockParam[]
    expect(assistantBlocks[0]).toEqual({
      type: "redacted_thinking",
      data: "OPAQUE_BYTES",
    } as Anthropic.RedactedThinkingBlockParam)
    // (use `blocks` to silence unused-var; sanity-check it's the user turn)
    expect(blocks).toBeDefined()
  })

  // NOTE: the end-to-end assemble→re-send roundtrips (plaintext byte-faithful,
  // redacted, and zero-thinking byte-identical) and the cache_control-anchor
  // regression are covered by the hell-gate superset
  // (anthropic-thinking-hell.test.ts: ROUND tests at lines 501/539/559 and
  // H-8 / H-8b). Deleted here to avoid duplication.
})

describe("ADR-0076 Gap-2 — assemble carry-over message shape", () => {
  test("assembleFromEvents output drops cleanly into a next-turn StreamInput.messages array", () => {
    const events: StreamEvent[] = [
      { type: "thinking_delta", text: "reason" },
      { type: "signature_delta", signature: "sig" },
      { type: "text_delta", delta: "answer" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    const { message } = assembleFromEvents(events)
    const next: StreamInput = {
      messages: [
        { role: "user", content: [{ type: "text", text: "q1" }] },
        message,
        { role: "user", content: [{ type: "text", text: "q2" }] },
      ],
      tools: [],
    }
    // The assembled assistant message is structurally valid as a StreamInput
    // entry — the agent loop does nothing more than push it onto wm.append
    // and read wm.snapshot() back into next-turn `messages`.
    expect(next.messages).toHaveLength(3)
    const asst = next.messages[1]
    expect(asst).toBeDefined()
    if (!asst) throw new Error("unreachable")
    expect(asst.role).toBe("assistant")
    const thinkingBlocks = asst.content.filter((b: ContentBlock) => b.type === "thinking")
    expect(thinkingBlocks).toHaveLength(1)
    expect(thinkingBlocks[0]).toEqual({
      type: "thinking",
      thinking: "reason",
      signature: "sig",
    })
  })
})
