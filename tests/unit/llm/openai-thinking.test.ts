/**
 * ADR-0076 Gap-2 — OpenAI adapter reasoning-summary delta → `thinking_delta`.
 *
 * Reasoning models (o-series, gpt-5) stream a human-readable summary of their
 * thinking on `delta.reasoning` (canonical) or `delta.reasoning_content`
 * (compat). The adapter must surface either as a `thinking_delta` StreamEvent
 * so `assembleFromEvents` can fold it into a {@link ThinkingBlock}. OpenAI
 * reasoning is OPAQUE — there is no client-visible signature, so the adapter
 * must NEVER emit a `signature_delta`. With neither field populated (legacy
 * models / no reasoning requested), zero thinking_deltas are emitted ⇒
 * byte-identical to the pre-feature path.
 */
import { describe, expect, test } from "bun:test"
import type OpenAI from "openai"
import { OpenAIAdapter } from "@/llm/adapters/openai"
import type { ContentBlock, StreamEvent, StreamInput } from "@/llm/types"

type ChatCompletionsCreate = typeof OpenAI.prototype.chat.completions.create

const collect = async (it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

/** Build a minimal RawChunk-shaped fake; the adapter cast strips SDK typing. */
const chunk = (
  delta: {
    content?: string | null
    reasoning?: string | null
    reasoning_content?: string | null
  },
  finish: string | null = null,
): unknown => ({
  choices: [{ delta, finish_reason: finish }],
  model: "gpt-5-test",
})

const lastUsage = (): unknown => ({
  choices: [{ delta: {}, finish_reason: "stop" }],
  model: "gpt-5-test",
  usage: { prompt_tokens: 5, completion_tokens: 7 },
})

const fakeStream = (chunks: unknown[]): AsyncIterable<unknown> => ({
  async *[Symbol.asyncIterator]() {
    for (const c of chunks) yield c
  },
})

const baseInput = (): StreamInput => ({
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [],
})

const adapter = (chunks: unknown[]): OpenAIAdapter => {
  const a = new OpenAIAdapter({ apiKey: "k", model: "gpt-5-test" })
  // biome-ignore lint/suspicious/noExplicitAny: test-double seam
  ;(a as any).client = {
    chat: {
      completions: {
        create: (async () => fakeStream(chunks)) as unknown as ChatCompletionsCreate,
      },
    },
  }
  return a
}

describe("ADR-0076 Gap-2 — OpenAI adapter reasoning → thinking_delta", () => {
  test("delta.reasoning surfaces as thinking_delta in stream order", async () => {
    const a = adapter([
      chunk({ reasoning: "let me " }),
      chunk({ reasoning: "think" }),
      chunk({ content: "the answer" }),
      lastUsage(),
    ])
    const out = await collect(a.stream(baseInput()))
    const thinking = out.filter((e) => e.type === "thinking_delta")
    expect(thinking).toEqual([
      { type: "thinking_delta", text: "let me " },
      { type: "thinking_delta", text: "think" },
    ])
  })

  test("delta.reasoning_content (compat naming) also surfaces", async () => {
    const a = adapter([chunk({ reasoning_content: "alt naming" }), lastUsage()])
    const out = await collect(a.stream(baseInput()))
    expect(out.filter((e) => e.type === "thinking_delta")).toEqual([
      { type: "thinking_delta", text: "alt naming" },
    ])
  })

  // NOTE: duplicate base tests deleted — covered verbatim by the hell-gate superset
  // (openai-thinking-hell.test.ts):
  //   - "prefer reasoning (no double-count)"        ⇒ O-1 (line 157)
  //   - "no reasoning fields → zero thinking_delta"  ⇒ O-4c (line 211)
  //   - "NEVER emits signature_delta"                ⇒ O-2 family (line 90, 100-chunk strict superset)
  //   - "reasoning before text_delta on same chunk"  ⇒ O-5 (line 221)
  //   - "empty / null reasoning dropped"             ⇒ O-4 / O-4b (lines 195, 201)

  test("multi-turn carry-over: assistant ThinkingBlock is dropped from outgoing OpenAI messages", async () => {
    // OpenAI Chat Completions has no input shape for thinking blocks. The
    // adapter must silently exclude them from `assistantParam` so a multi-turn
    // request that contains a prior ThinkingBlock does not 400.
    const { assistantParam } = await import("@/llm/adapters/openai")
    const content: ContentBlock[] = [
      { type: "thinking", thinking: "reason", signature: "sig" },
      { type: "text", text: "spoken" },
    ]
    const param = assistantParam(content)
    expect(param).toEqual({ role: "assistant", content: "spoken" })
  })
})
