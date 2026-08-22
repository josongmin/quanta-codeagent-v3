/**
 * ADR-0076 Gap-2 — OpenAI adapter reasoning-summary HELL-GATE.
 *
 * NEGATIVE INVARIANT #4 (ADR-0076):
 *   `thinking_delta` events with no `signature_delta` are valid — OpenAI
 *   reasoning summary has no signature. **Adapters MUST NOT synthesize a fake
 *   signature.**
 *
 * The OpenAI adapter has TWO orthogonal contracts to pin:
 *
 *   O-1  Reasoning-summary surfacing: `delta.reasoning` (canonical) and
 *        `delta.reasoning_content` (compat) BOTH surface as `thinking_delta`,
 *        with `reasoning` preferred when both fields populated on the same
 *        chunk (no double-count).
 *   O-2  signature_delta is NEVER emitted by this adapter — no provider event,
 *        no synthetic fabrication. The output stream from a 1000-chunk
 *        reasoning turn carries zero signature_delta events.
 *   O-3  Multi-turn carry-over: a ThinkingBlock on a prior assistant turn
 *        is DROPPED from the outgoing `assistantParam` — OpenAI Chat
 *        Completions has no input shape for reasoning blocks.
 *   O-4  Empty / null reasoning fields are skipped (no zero-length
 *        thinking_delta emitted).
 *   O-5  reasoning + content on the SAME chunk ⇒ thinking_delta BEFORE
 *        text_delta in stream order (reasoning naturally precedes the
 *        narration it explains).
 *   O-6  Massive reasoning stream (thousands of chunks) round-trips into
 *        ONE accumulated ThinkingBlock at the assemble layer.
 */
import { describe, expect, test } from "bun:test"
import type OpenAI from "openai"
import { assistantParam, OpenAIAdapter } from "@/llm/adapters/openai"
import { assembleFromEvents } from "@/llm/assemble"
import type { ContentBlock, Message, StreamEvent, StreamInput, ThinkingBlock } from "@/llm/types"

type ChatCompletionsCreate = typeof OpenAI.prototype.chat.completions.create

// ─── Fake stream helpers (shared shape with baseline test) ────────────────

const collect = async (it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

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

const finalChunk = (): unknown => ({
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

// ─── O-2 — NEGATIVE INVARIANT #4 (HEADLINE) ────────────────────────────────

describe("ADR-0076 NI-4 — OpenAI adapter NEVER emits signature_delta", () => {
  test("O-2: 100 reasoning chunks ⇒ ZERO signature_delta events", async () => {
    const chunks: unknown[] = []
    for (let i = 0; i < 100; i++) chunks.push(chunk({ reasoning: `step ${i} ` }))
    chunks.push(chunk({ content: "answer" }))
    chunks.push(finalChunk())
    const a = adapter(chunks)
    const out = await collect(a.stream(baseInput()))
    const sigs = out.filter((e) => e.type === "signature_delta")
    expect(sigs).toHaveLength(0)
  })

  test("O-2b: when both reasoning AND reasoning_content present across many chunks, still no signature_delta", async () => {
    const chunks: unknown[] = []
    for (let i = 0; i < 50; i++) {
      chunks.push(chunk({ reasoning: "R", reasoning_content: "C" }))
    }
    chunks.push(finalChunk())
    const a = adapter(chunks)
    const out = await collect(a.stream(baseInput()))
    expect(out.some((e) => e.type === "signature_delta")).toBe(false)
  })

  test("O-2c: tool_calls + reasoning + content interleaved ⇒ still no signature_delta", async () => {
    // Adversarial: a malformed provider that streams every event kind at
    // once. The adapter must still never emit signature_delta.
    const a = adapter([
      {
        choices: [
          {
            delta: {
              reasoning: "thinking",
              content: "answer",
              tool_calls: [{ index: 0, id: "t1", function: { name: "read", arguments: "{}" } }],
            },
            finish_reason: null,
          },
        ],
        model: "gpt-5-test",
      },
      finalChunk(),
    ])
    const out = await collect(a.stream(baseInput()))
    expect(out.some((e) => e.type === "signature_delta")).toBe(false)
  })

  test("O-2d: end-to-end through assemble — accumulated ThinkingBlock has NO signature field", async () => {
    // The full chain: OpenAI adapter → StreamEvent stream → assemble. The
    // resulting ThinkingBlock must lack `signature` entirely (the field is
    // optional and absent for OpenAI by design).
    const a = adapter([
      chunk({ reasoning: "let me think " }),
      chunk({ reasoning: "carefully" }),
      chunk({ content: "answer" }),
      finalChunk(),
    ])
    const out = await collect(a.stream(baseInput()))
    const { message } = assembleFromEvents(out)
    const tBlocks = message.content.filter((b): b is ThinkingBlock => b.type === "thinking")
    expect(tBlocks).toHaveLength(1)
    expect(tBlocks[0]?.thinking).toBe("let me think carefully")
    expect(tBlocks[0]?.signature).toBeUndefined()
  })
})

// ─── O-1 — reasoning vs reasoning_content precedence ──────────────────────

describe("ADR-0076 Gap-2 HELL — reasoning field precedence", () => {
  test("O-1: both populated ⇒ prefer canonical `reasoning`", async () => {
    const a = adapter([
      chunk({ reasoning: "canonical", reasoning_content: "compat-duplicate" }),
      finalChunk(),
    ])
    const out = await collect(a.stream(baseInput()))
    const thinking = out.filter((e) => e.type === "thinking_delta")
    expect(thinking).toEqual([{ type: "thinking_delta", text: "canonical" }])
  })

  test("O-1b: only `reasoning_content` populated ⇒ surfaces it (compat path)", async () => {
    const a = adapter([chunk({ reasoning_content: "only-compat" }), finalChunk()])
    const out = await collect(a.stream(baseInput()))
    expect(out.filter((e) => e.type === "thinking_delta")).toEqual([
      { type: "thinking_delta", text: "only-compat" },
    ])
  })

  test("O-1c: mix across chunks (canonical → compat → canonical) preserves all text", async () => {
    const a = adapter([
      chunk({ reasoning: "A" }),
      chunk({ reasoning_content: "B" }),
      chunk({ reasoning: "C" }),
      finalChunk(),
    ])
    const out = await collect(a.stream(baseInput()))
    const tds = out.filter((e) => e.type === "thinking_delta")
    expect(tds).toEqual([
      { type: "thinking_delta", text: "A" },
      { type: "thinking_delta", text: "B" },
      { type: "thinking_delta", text: "C" },
    ])
  })
})

// ─── O-4 — empty / null reasoning is skipped ──────────────────────────────

describe("ADR-0076 Gap-2 HELL — empty / null reasoning gating", () => {
  test("O-4: empty-string reasoning ⇒ no thinking_delta", async () => {
    const a = adapter([chunk({ reasoning: "" }), chunk({ content: "x" }), finalChunk()])
    const out = await collect(a.stream(baseInput()))
    expect(out.some((e) => e.type === "thinking_delta")).toBe(false)
  })

  test("O-4b: null reasoning + null reasoning_content ⇒ no thinking_delta", async () => {
    const a = adapter([
      chunk({ reasoning: null, reasoning_content: null }),
      chunk({ content: "x" }),
      finalChunk(),
    ])
    const out = await collect(a.stream(baseInput()))
    expect(out.some((e) => e.type === "thinking_delta")).toBe(false)
  })

  test("O-4c: missing both fields ⇒ no thinking_delta (legacy non-reasoning model)", async () => {
    const a = adapter([chunk({ content: "plain text only" }), finalChunk()])
    const out = await collect(a.stream(baseInput()))
    expect(out.some((e) => e.type === "thinking_delta")).toBe(false)
  })
})

// ─── O-5 — chunk-internal ordering ─────────────────────────────────────────

describe("ADR-0076 Gap-2 HELL — chunk-internal event ordering", () => {
  test("O-5: reasoning + content on same chunk ⇒ thinking_delta precedes text_delta", async () => {
    const a = adapter([chunk({ reasoning: "R", content: "T" }), finalChunk()])
    const out = await collect(a.stream(baseInput()))
    const idxT = out.findIndex((e) => e.type === "thinking_delta")
    const idxX = out.findIndex((e) => e.type === "text_delta")
    expect(idxT).toBeGreaterThanOrEqual(0)
    expect(idxX).toBeGreaterThan(idxT)
  })

  test("O-5b: reasoning + content + tool_calls same chunk ⇒ thinking_delta first", async () => {
    const a = adapter([
      {
        choices: [
          {
            delta: {
              reasoning: "thinking",
              content: "speak",
              tool_calls: [{ index: 0, id: "t1", function: { name: "read", arguments: "{}" } }],
            },
            finish_reason: null,
          },
        ],
        model: "gpt-5-test",
      },
      finalChunk(),
    ])
    const out = await collect(a.stream(baseInput()))
    const order = out
      .map((e) => e.type)
      .filter((t) => t === "thinking_delta" || t === "text_delta" || t === "tool_use_start")
    expect(order[0]).toBe("thinking_delta")
  })
})

// ─── O-6 — high-volume reasoning stream ────────────────────────────────────

describe("ADR-0076 Gap-2 HELL — high-volume reasoning stream", () => {
  test("O-6: 2000 reasoning chunks fold into ONE assembled ThinkingBlock", async () => {
    const chunks: unknown[] = []
    for (let i = 0; i < 2000; i++) chunks.push(chunk({ reasoning: "x" }))
    chunks.push(chunk({ content: "answer" }))
    chunks.push(finalChunk())
    const a = adapter(chunks)
    const out = await collect(a.stream(baseInput()))
    expect(out.filter((e) => e.type === "thinking_delta")).toHaveLength(2000)
    const { message } = assembleFromEvents(out)
    const t = message.content.filter((b): b is ThinkingBlock => b.type === "thinking")
    expect(t).toHaveLength(1)
    expect(t[0]?.thinking.length).toBe(2000)
  })

  test("O-6b: multi-byte unicode reasoning roundtrips bytewise", async () => {
    const a = adapter([
      chunk({ reasoning: "한국어 추론 · " }),
      chunk({ reasoning: "思考 · 🧠✨" }),
      chunk({ content: "answer" }),
      finalChunk(),
    ])
    const out = await collect(a.stream(baseInput()))
    const { message } = assembleFromEvents(out)
    const t = message.content.find((b): b is ThinkingBlock => b.type === "thinking")
    expect(t?.thinking).toBe("한국어 추론 · 思考 · 🧠✨")
  })
})

// ─── O-3 — multi-turn carry-over: ThinkingBlock is dropped from outgoing ───

describe("ADR-0076 Gap-2 HELL — OpenAI multi-turn carry-over drops thinking", () => {
  test("O-3: a prior-turn assistant Message with ThinkingBlock + text ⇒ assistantParam content === text only", () => {
    const content: ContentBlock[] = [
      { type: "thinking", thinking: "from a prior turn", signature: "sig-from-anthropic" },
      { type: "text", text: "I see" },
    ]
    const param = assistantParam(content)
    expect(param).toEqual({ role: "assistant", content: "I see" })
  })

  test("O-3b: redacted ThinkingBlock is also dropped (OpenAI has no input shape for it)", () => {
    const content: ContentBlock[] = [
      { type: "thinking", thinking: "CIPHER", redacted: true },
      { type: "text", text: "answer" },
    ]
    const param = assistantParam(content)
    expect(param).toEqual({ role: "assistant", content: "answer" })
  })

  test("O-3c: ONLY a ThinkingBlock (no text/tool_use) ⇒ assistantParam content === null", () => {
    // OpenAI treats an assistant message with no usable content as content:null.
    const content: ContentBlock[] = [{ type: "thinking", thinking: "x", signature: "s" }]
    const param = assistantParam(content)
    expect(param).toEqual({ role: "assistant", content: null })
  })

  test("O-3d: tool_use + thinking ⇒ thinking dropped, tool_calls preserved", () => {
    const content: ContentBlock[] = [
      { type: "thinking", thinking: "decide", signature: "s" },
      { type: "tool_use", id: "t1", name: "read", input: { path: "a.ts" } },
    ]
    const param = assistantParam(content)
    expect(param.role).toBe("assistant")
    expect(param.content).toBeNull()
    expect("tool_calls" in param && param.tool_calls).toEqual([
      { id: "t1", type: "function", function: { name: "read", arguments: '{"path":"a.ts"}' } },
    ])
  })

  test("O-3e: multi-turn through full adapter — outgoing payload has no reasoning fields on prior assistant", async () => {
    // The Chat Completions API has no `reasoning` field for assistant messages.
    // Verify the captured outgoing body's assistant message carries no
    // reasoning content (only the text).
    const a = new OpenAIAdapter({ apiKey: "k", model: "gpt-5-test" })
    let capturedBody: Record<string, unknown> | undefined
    // biome-ignore lint/suspicious/noExplicitAny: test-double seam
    ;(a as any).client = {
      chat: {
        completions: {
          create: (async (body: Record<string, unknown>) => {
            capturedBody = body
            return fakeStream([finalChunk()])
          }) as unknown as ChatCompletionsCreate,
        },
      },
    }
    const prior: Message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "deliberation", signature: "sig" },
        { type: "text", text: "spoken answer" },
      ],
    }
    const input: StreamInput = {
      messages: [
        { role: "user", content: [{ type: "text", text: "q" }] },
        prior,
        { role: "user", content: [{ type: "text", text: "follow-up" }] },
      ],
      tools: [],
    }
    for await (const _ of a.stream(input)) {
      // drain
    }
    expect(capturedBody).toBeDefined()
    const msgs = capturedBody?.messages as { role: string; content?: unknown }[]
    const asst = msgs.find((m) => m.role === "assistant")
    expect(asst?.content).toBe("spoken answer")
    // The thinking content must not appear ANYWHERE on the outgoing wire.
    const wire = JSON.stringify(capturedBody)
    expect(wire).not.toContain("deliberation")
    expect(wire).not.toContain("sig")
  })
})

// ─── End-of-stream invariants ──────────────────────────────────────────────

describe("ADR-0076 Gap-2 HELL — end-of-stream invariants under thinking", () => {
  test("reasoning-only stream finishes with stop_reason mapped via STOP_REASON table", async () => {
    const a = adapter([
      chunk({ reasoning: "only thinking, no spoken answer" }, "stop"),
      finalChunk(),
    ])
    const out = await collect(a.stream(baseInput()))
    const stop = out.find((e) => e.type === "message_stop")
    expect(stop && stop.type === "message_stop" && stop.stop_reason).toBe("end_turn")
  })

  test("finish_reason 'content_filter' (OpenAI guardrail) passes through unchanged (NI-2 cross-check)", async () => {
    // The OpenAI STOP_REASON map only covers 'tool_calls', 'stop', 'length'.
    // 'content_filter' is NOT mapped — it passes through verbatim, and
    // decideOnAssembled routes it to `proceed` (NI-2). The Anthropic literal
    // is `content_filtered` (different word; structurally equivalent).
    //
    // No trailing finalChunk: processChunk overwrites `st.finish` on every
    // non-null finish_reason it sees, so we must terminate the stream on
    // the content_filter chunk itself to observe it.
    const a = adapter([chunk({ content: "redacted" }, "content_filter")])
    const out = await collect(a.stream(baseInput()))
    const stop = out.find((e) => e.type === "message_stop")
    expect(stop && stop.type === "message_stop" && stop.stop_reason).toBe("content_filter")
  })
})
