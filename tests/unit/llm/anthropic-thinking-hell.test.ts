/**
 * ADR-0076 Gap-2 — Anthropic adapter extended-thinking HELL-GATE.
 *
 * Adversarial pinning of the Anthropic-specific SSE → StreamEvent translation
 * and the carry-over serialization back to `Anthropic.ContentBlockParam`:
 *
 *   H-1  `content_block_delta` with an unknown / novel `delta.type` MUST yield
 *        ZERO events — never throw. The stream must survive a future provider
 *        delta type without breaking the turn (defensive `mapRawEvent` switch).
 *   H-2  `redacted_thinking` ALWAYS arrives whole on the start event — never
 *        as deltas. The adapter emits exactly ONE redacted thinking_delta
 *        carrying the opaque ciphertext.
 *   H-3  Carry-over byte-faithfulness: a ThinkingBlock with a real signature
 *        round-trips to the on-wire `{type:"thinking", thinking, signature}`
 *        param, including for non-ASCII / 4KB+ payloads. A redacted block
 *        round-trips to `{type:"redacted_thinking", data}`.
 *   H-4  An assistant Message that contains BOTH a ThinkingBlock (with
 *        signature) AND a TextBlock + ToolUseBlock serializes ALL THREE on
 *        the wire, in order.
 *   H-5  Multiple ThinkingBlocks on one Message (provider streamed two
 *        thinking runs interleaved by text) all round-trip with their
 *        respective signatures.
 *   H-6  Carry-over invariant (negative): a ThinkingBlock with a missing
 *        signature is DROPPED on the wire (legacy / disabled-budget guard).
 *        Wide coverage: pre-feature legacy turn, hand-rolled message,
 *        compaction-output stale block — all silently strip the thinking.
 *   H-7  Carry-over invariant (negative): a redacted block with an EMPTY
 *        `thinking` ciphertext field still serializes as redacted_thinking —
 *        we forward whatever the provider gave us, never invent or drop.
 *   H-8  `cache_control` anchor regression: a thinking block in the LAST
 *        message must NEVER receive the cache_control breakpoint (the
 *        anchor walks backward to find a text block; thinking blocks fail
 *        the lookup).
 *
 *  The fake SDK client mirrors the baseline tests' shape (chat completions
 *  create() captures the body).
 */
import { describe, expect, test } from "bun:test"
import type Anthropic from "@anthropic-ai/sdk"
import type { OpenSlots, RawEvent, UsageAccumulator } from "@/llm/adapters/anthropic"
import { AnthropicAdapter, mapRawEvent } from "@/llm/adapters/anthropic"
import { assembleFromEvents } from "@/llm/assemble"
import type { Message, StreamEvent, StreamInput } from "@/llm/types"

// ─── Fake client helper (shared with baseline test shape) ─────────────────

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
            yield { type: "message_delta", delta: { stop_reason: "end_turn" } } as RawEvent
          },
        }
      },
    },
  }
  return { adapter, captured }
}

const drive = (raws: RawEvent[]): StreamEvent[] => {
  const open: OpenSlots = new Map()
  const usage: UsageAccumulator = {}
  const out: StreamEvent[] = []
  for (const r of raws) for (const ev of mapRawEvent(r, open, usage)) out.push(ev)
  return out
}

// ─── H-1 — unknown delta types survive ────────────────────────────────────

describe("ADR-0076 Gap-2 HELL — Anthropic mapRawEvent unknown-delta tolerance", () => {
  test("H-1: an unknown content_block_delta.type emits ZERO events (no throw)", () => {
    // Stress: a future provider rolls out a brand-new delta kind. The switch
    // in `mapRawEvent` must fall through silently — no throw, no synthetic
    // event. The adapter is forward-compatible with novel deltas.
    const events = drive([
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      {
        type: "content_block_delta",
        index: 0,
        // biome-ignore lint/suspicious/noExplicitAny: stress test
        delta: { type: "future_kind_2030", payload: "x" } as any,
      },
      { type: "content_block_stop", index: 0 },
    ] as RawEvent[])
    expect(events).toEqual([])
  })

  test("H-1b: an unknown raw event kind also emits nothing (defensive top-level switch)", () => {
    // biome-ignore lint/suspicious/noExplicitAny: stress test
    const events = drive([{ type: "future_top_level_event" } as any])
    expect(events).toEqual([])
  })

  test("H-1c: ping event (heartbeat) emits nothing", () => {
    const events = drive([{ type: "ping" } as RawEvent])
    expect(events).toEqual([])
  })
})

// ─── H-2 — redacted_thinking whole-on-start ────────────────────────────────

describe("ADR-0076 Gap-2 HELL — redacted_thinking SSE", () => {
  test("H-2: redacted_thinking start ALWAYS emits exactly one redacted thinking_delta", () => {
    const events = drive([
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "redacted_thinking", data: "OPAQUE_BYTES" },
      },
      { type: "content_block_stop", index: 0 },
    ] as RawEvent[])
    expect(events).toEqual([{ type: "thinking_delta", text: "OPAQUE_BYTES", redacted: true }])
  })

  test("H-2b: redacted_thinking with empty `data` still emits ONE redacted thinking_delta", () => {
    // The provider's payload contract — we never silently drop a block the
    // provider sent. Empty ciphertext is unusual but valid for round-trip.
    const events = drive([
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "redacted_thinking", data: "" },
      },
      { type: "content_block_stop", index: 0 },
    ] as RawEvent[])
    expect(events).toEqual([{ type: "thinking_delta", text: "", redacted: true }])
  })

  test("H-2c: redacted + plaintext interleaved across multiple indices preserves block order", () => {
    const events = drive([
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "redacted_thinking", data: "ENC1" },
      },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "thinking" } },
      { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "P1" } },
      { type: "content_block_stop", index: 1 },
      {
        type: "content_block_start",
        index: 2,
        content_block: { type: "redacted_thinking", data: "ENC2" },
      },
      { type: "content_block_stop", index: 2 },
    ] as RawEvent[])
    expect(events).toEqual([
      { type: "thinking_delta", text: "ENC1", redacted: true },
      { type: "thinking_delta", text: "P1" },
      { type: "thinking_delta", text: "ENC2", redacted: true },
    ])
  })
})

// ─── H-3 — carry-over byte-faithfulness ───────────────────────────────────

describe("ADR-0076 Gap-2 HELL — carry-over byte-faithfulness", () => {
  test("H-3: 4KB+ thinking + 4KB+ signature serialize verbatim onto the wire", async () => {
    const { adapter, captured } = adapterWithCapture()
    const longThink = "T".repeat(8192)
    const longSig = "S".repeat(8192)
    const prior: Message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: longThink, signature: longSig },
        { type: "text", text: "ok" },
      ],
    }
    const input: StreamInput = {
      messages: [prior, { role: "user", content: [{ type: "text", text: "next" }] }],
      tools: [],
    }
    for await (const _ of adapter.stream(input)) {
      // drain
    }
    const msgs = captured.body?.messages as Anthropic.MessageParam[]
    const blocks = msgs[0]?.content as Anthropic.ContentBlockParam[]
    expect(blocks[0]).toEqual({
      type: "thinking",
      thinking: longThink,
      signature: longSig,
    } as Anthropic.ThinkingBlockParam)
  })

  test("H-3b: non-ASCII unicode thinking + signature roundtrip bytewise", async () => {
    const { adapter, captured } = adapterWithCapture()
    const thinking = "한국어 한자 · 思考 · 🧠 reasoning"
    const signature = "sig: ÿ·🔒·\u{1F90D}"
    const prior: Message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking, signature },
        { type: "text", text: "done" },
      ],
    }
    const input: StreamInput = {
      messages: [prior, { role: "user", content: [{ type: "text", text: "go" }] }],
      tools: [],
    }
    for await (const _ of adapter.stream(input)) {
      // drain
    }
    const msgs = captured.body?.messages as Anthropic.MessageParam[]
    const blocks = msgs[0]?.content as Anthropic.ContentBlockParam[]
    expect(blocks[0]).toEqual({ type: "thinking", thinking, signature })
  })

  test("H-3c: empty-string signature is honored (block ships with `signature: ''`)", async () => {
    // assemble.ts sets signature='' when an empty signature_delta arrives;
    // the adapter check is `signature === undefined`, NOT `signature == ''`,
    // so an empty signature serializes as-is (and a future audit may reject
    // it on the provider side — but the adapter doesn't drop it).
    const { adapter, captured } = adapterWithCapture()
    const prior: Message = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "x", signature: "" }],
    }
    const input: StreamInput = {
      messages: [prior, { role: "user", content: [{ type: "text", text: "next" }] }],
      tools: [],
    }
    for await (const _ of adapter.stream(input)) {
      // drain
    }
    const msgs = captured.body?.messages as Anthropic.MessageParam[]
    const blocks = msgs[0]?.content as Anthropic.ContentBlockParam[]
    expect(blocks).toContainEqual({ type: "thinking", thinking: "x", signature: "" })
  })
})

// ─── H-4 — full assistant message (thinking + text + tool_use) ────────────

describe("ADR-0076 Gap-2 HELL — full assistant message carry-over", () => {
  test("H-4: thinking + text + tool_use all serialize in provider order", async () => {
    const { adapter, captured } = adapterWithCapture()
    const prior: Message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "think", signature: "s" },
        { type: "text", text: "narrate" },
        { type: "tool_use", id: "t1", name: "read", input: { path: "/a" } },
      ],
    }
    const input: StreamInput = {
      messages: [
        { role: "user", content: [{ type: "text", text: "q" }] },
        prior,
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      ],
      tools: [],
    }
    for await (const _ of adapter.stream(input)) {
      // drain
    }
    const msgs = captured.body?.messages as Anthropic.MessageParam[]
    const blocks = msgs[1]?.content as Anthropic.ContentBlockParam[]
    expect(blocks.map((b) => b.type)).toEqual(["thinking", "text", "tool_use"])
  })
})

// ─── H-5 — multiple ThinkingBlocks roundtrip ──────────────────────────────

describe("ADR-0076 Gap-2 HELL — multi-block thinking roundtrip", () => {
  test("H-5: two separate ThinkingBlocks each keep their own signature", async () => {
    const { adapter, captured } = adapterWithCapture()
    const prior: Message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "A", signature: "sigA" },
        { type: "text", text: "interlude" },
        { type: "thinking", thinking: "B", signature: "sigB" },
        { type: "text", text: "final" },
      ],
    }
    const input: StreamInput = {
      messages: [prior, { role: "user", content: [{ type: "text", text: "next" }] }],
      tools: [],
    }
    for await (const _ of adapter.stream(input)) {
      // drain
    }
    const msgs = captured.body?.messages as Anthropic.MessageParam[]
    const blocks = msgs[0]?.content as Anthropic.ContentBlockParam[]
    const thinking = blocks.filter((b) => b.type === "thinking")
    expect(thinking).toEqual([
      { type: "thinking", thinking: "A", signature: "sigA" },
      { type: "thinking", thinking: "B", signature: "sigB" },
    ] as Anthropic.ThinkingBlockParam[])
  })

  test("H-5b: redacted + plaintext + redacted in one message all serialize correctly", async () => {
    const { adapter, captured } = adapterWithCapture()
    const prior: Message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "ENC1", redacted: true },
        { type: "thinking", thinking: "plain", signature: "sigP" },
        { type: "thinking", thinking: "ENC2", redacted: true },
        { type: "text", text: "ok" },
      ],
    }
    const input: StreamInput = {
      messages: [prior, { role: "user", content: [{ type: "text", text: "x" }] }],
      tools: [],
    }
    for await (const _ of adapter.stream(input)) {
      // drain
    }
    const msgs = captured.body?.messages as Anthropic.MessageParam[]
    const blocks = msgs[0]?.content as Anthropic.ContentBlockParam[]
    expect(blocks[0]).toEqual({ type: "redacted_thinking", data: "ENC1" })
    expect(blocks[1]).toEqual({ type: "thinking", thinking: "plain", signature: "sigP" })
    expect(blocks[2]).toEqual({ type: "redacted_thinking", data: "ENC2" })
  })
})

// ─── H-6 — negative carry-over (signature-less plaintext is DROPPED) ──────

describe("ADR-0076 Gap-2 HELL — signature-less ThinkingBlock is dropped on wire", () => {
  test("H-6: signature-less plaintext thinking is dropped (legacy / disabled-budget guard)", async () => {
    // The adapter check at line ~113: `if (block.signature === undefined) return null`.
    // This is the byte-identical guard: a pre-feature legacy turn or a hand-
    // built message must never break the request. A signature-less thinking
    // block is structurally impossible from a current Anthropic stream (the
    // assembler always pairs thinking+signature for plaintext), so dropping
    // it is safe + necessary.
    const { adapter, captured } = adapterWithCapture()
    const stale: Message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "stray legacy block" },
        { type: "text", text: "spoken" },
      ],
    }
    const input: StreamInput = {
      messages: [stale, { role: "user", content: [{ type: "text", text: "now" }] }],
      tools: [],
    }
    for await (const _ of adapter.stream(input)) {
      // drain
    }
    const msgs = captured.body?.messages as Anthropic.MessageParam[]
    const blocks = msgs[0]?.content as Anthropic.ContentBlockParam[]
    expect(blocks.some((b) => b.type === "thinking")).toBe(false)
    expect(blocks).toContainEqual({ type: "text", text: "spoken" })
  })

  test("H-6b: a message with ONLY a signature-less thinking ⇒ empty content blocks", async () => {
    const { adapter, captured } = adapterWithCapture()
    const onlyThinking: Message = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "stale" }],
    }
    const input: StreamInput = {
      messages: [onlyThinking, { role: "user", content: [{ type: "text", text: "x" }] }],
      tools: [],
    }
    for await (const _ of adapter.stream(input)) {
      // drain
    }
    const msgs = captured.body?.messages as Anthropic.MessageParam[]
    const blocks = msgs[0]?.content as Anthropic.ContentBlockParam[]
    expect(blocks).toEqual([])
  })
})

// ─── H-7 — empty redacted ciphertext still ships as redacted_thinking ─────

describe("ADR-0076 Gap-2 HELL — redacted block edge cases", () => {
  test("H-7: redacted block with empty ciphertext serializes as redacted_thinking with data: ''", async () => {
    const { adapter, captured } = adapterWithCapture()
    const prior: Message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", redacted: true },
        { type: "text", text: "ok" },
      ],
    }
    const input: StreamInput = {
      messages: [prior, { role: "user", content: [{ type: "text", text: "x" }] }],
      tools: [],
    }
    for await (const _ of adapter.stream(input)) {
      // drain
    }
    const msgs = captured.body?.messages as Anthropic.MessageParam[]
    const blocks = msgs[0]?.content as Anthropic.ContentBlockParam[]
    expect(blocks[0]).toEqual({ type: "redacted_thinking", data: "" })
  })

  test("H-7b: redacted block ignores `signature` field (precedence)", async () => {
    // A redacted block carries ciphertext in `thinking`; if a `signature`
    // accidentally rides along, the adapter still serializes it as
    // `redacted_thinking` (precedence: `if (block.redacted)` wins).
    const { adapter, captured } = adapterWithCapture()
    // NOTE: the type union doesn't preclude this combo (both signature and
    // redacted are optional on ThinkingBlock); we exercise the runtime
    // precedence path. A future tightening could add a discriminated subtype
    // for redacted-only — until then the runtime branch is the only
    // protection.
    const prior: Message = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "ENC", redacted: true, signature: "ignored" }],
    }
    const input: StreamInput = {
      messages: [prior, { role: "user", content: [{ type: "text", text: "x" }] }],
      tools: [],
    }
    for await (const _ of adapter.stream(input)) {
      // drain
    }
    const msgs = captured.body?.messages as Anthropic.MessageParam[]
    const blocks = msgs[0]?.content as Anthropic.ContentBlockParam[]
    // The redacted shape wins; the spurious signature is dropped.
    expect(blocks[0]).toEqual({ type: "redacted_thinking", data: "ENC" })
  })
})

// ─── H-8 — cache_control anchor regression ────────────────────────────────

describe("ADR-0076 Gap-2 HELL — cache_control anchor never lands on thinking blocks", () => {
  test("H-8: trailing thinking block in LAST message ⇒ cache_control NOT placed on it", async () => {
    // The cache prefix walker (`cacheConversationPrefix`) walks backward to
    // find a TEXT block. A thinking trailing block must be skipped.
    const { adapter, captured } = adapterWithCapture()
    // The "last message" is the trailing user message. Anthropic doesn't
    // accept thinking on a user message structurally, but the walker is
    // defensive: it scans whatever block kinds are present.
    const input: StreamInput = {
      messages: [
        { role: "user", content: [{ type: "text", text: "the question" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "t", signature: "s" },
            { type: "text", text: "answer" },
          ],
        },
        // Trailing user message with a single text block — that's the cache
        // anchor location.
        { role: "user", content: [{ type: "text", text: "follow-up" }] },
      ],
      tools: [],
    }
    for await (const _ of adapter.stream(input)) {
      // drain
    }
    const msgs = captured.body?.messages as Anthropic.MessageParam[]
    const lastBlocks = msgs[msgs.length - 1]?.content as Anthropic.ContentBlockParam[]
    // The cache_control anchor is on the LAST message's text block.
    expect((lastBlocks[0] as { cache_control?: unknown }).cache_control).toBeDefined()

    // The thinking block on the prior assistant message must NEVER have
    // cache_control — the API silently drops it there and the breakpoint
    // would evaporate.
    const asstBlocks = msgs[1]?.content as Anthropic.ContentBlockParam[]
    const thinkingBlock = asstBlocks.find((b) => b.type === "thinking") as
      | (Anthropic.ContentBlockParam & { cache_control?: unknown })
      | undefined
    expect(thinkingBlock?.cache_control).toBeUndefined()
  })

  test("H-8b: assistant message ending with thinking (no trailing text) ⇒ no cache_control attached", async () => {
    // Regression: if the trailing message ends with a non-text block (here,
    // thinking on an assistant turn is the LAST message), the walker returns
    // unchanged — no cache breakpoint on the conversation prefix this turn.
    const { adapter, captured } = adapterWithCapture()
    const input: StreamInput = {
      messages: [
        { role: "user", content: [{ type: "text", text: "q" }] },
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "t", signature: "s" }],
        },
      ],
      tools: [],
    }
    for await (const _ of adapter.stream(input)) {
      // drain
    }
    const msgs = captured.body?.messages as Anthropic.MessageParam[]
    const lastBlocks = msgs[msgs.length - 1]?.content as Anthropic.ContentBlockParam[]
    // The only block is thinking; it must NOT have cache_control.
    const tBlock = lastBlocks[0] as Anthropic.ContentBlockParam & { cache_control?: unknown }
    expect(tBlock.cache_control).toBeUndefined()
  })
})

// ─── End-to-end roundtrip (assembled message → wire → assembled again) ────

describe("ADR-0076 Gap-2 HELL — assemble × adapter wire-faithful roundtrip", () => {
  test("ROUND: thinking + text → assembled → re-sent → byte-faithful wire shape", async () => {
    const events: StreamEvent[] = [
      { type: "thinking_delta", text: "alpha " },
      { type: "thinking_delta", text: "beta " },
      { type: "thinking_delta", text: "gamma" },
      { type: "signature_delta", signature: "SIG_" },
      { type: "signature_delta", signature: "X" },
      { type: "text_delta", delta: "result" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    const { message } = assembleFromEvents(events)
    expect(message.content).toEqual([
      { type: "thinking", thinking: "alpha beta gamma", signature: "SIG_X" },
      { type: "text", text: "result" },
    ])
    const { adapter, captured } = adapterWithCapture()
    const next: StreamInput = {
      messages: [
        { role: "user", content: [{ type: "text", text: "q" }] },
        message,
        { role: "user", content: [{ type: "text", text: "follow-up" }] },
      ],
      tools: [],
    }
    for await (const _ of adapter.stream(next)) {
      // drain
    }
    const msgs = captured.body?.messages as Anthropic.MessageParam[]
    const blocks = msgs[1]?.content as Anthropic.ContentBlockParam[]
    expect(blocks).toEqual([
      { type: "thinking", thinking: "alpha beta gamma", signature: "SIG_X" },
      { type: "text", text: "result" },
    ] as Anthropic.ContentBlockParam[])
  })

  test("ROUND: redacted-only turn → assembled → re-sent → redacted_thinking on wire", async () => {
    const events: StreamEvent[] = [
      { type: "thinking_delta", text: "OPAQUE", redacted: true },
      { type: "text_delta", delta: "ok" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    const { message } = assembleFromEvents(events)
    const { adapter, captured } = adapterWithCapture()
    const next: StreamInput = {
      messages: [message, { role: "user", content: [{ type: "text", text: "n" }] }],
      tools: [],
    }
    for await (const _ of adapter.stream(next)) {
      // drain
    }
    const msgs = captured.body?.messages as Anthropic.MessageParam[]
    const blocks = msgs[0]?.content as Anthropic.ContentBlockParam[]
    expect(blocks[0]).toEqual({ type: "redacted_thinking", data: "OPAQUE" })
  })

  test("ROUND: zero-thinking turn ⇒ no thinking ContentBlockParam (byte-identical pre-feature)", async () => {
    const events: StreamEvent[] = [
      { type: "text_delta", delta: "plain answer" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    const { message } = assembleFromEvents(events)
    const { adapter, captured } = adapterWithCapture()
    const next: StreamInput = {
      messages: [message, { role: "user", content: [{ type: "text", text: "x" }] }],
      tools: [],
    }
    for await (const _ of adapter.stream(next)) {
      // drain
    }
    const msgs = captured.body?.messages as Anthropic.MessageParam[]
    const blocks = msgs[0]?.content as Anthropic.ContentBlockParam[]
    expect(blocks.some((b) => b.type === "thinking" || b.type === "redacted_thinking")).toBe(false)
  })
})
