import { describe, expect, test } from "bun:test"
import { estimateTokensFromChars, withLiveUsage } from "@/llm/live-usage"
import type { LLMPort } from "@/llm/ports"
import type { StreamEvent, StreamInput } from "@/llm/types"

/** Build a mock inner port that yields a scripted event sequence. Records the
 *  StreamInput it was called with so passthrough/identity can be asserted. */
const mockPort = (events: StreamEvent[], extra: Partial<LLMPort> = {}): LLMPort => ({
  model: "test-model",
  provider: "anthropic",
  ...extra,
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    for (const ev of events) yield ev
  },
})

const drain = async (port: LLMPort): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = []
  for await (const ev of port.stream({ messages: [], tools: [] })) out.push(ev)
  return out
}

const progressOf = (events: StreamEvent[]) =>
  events.filter(
    (e): e is Extract<StreamEvent, { type: "output_progress" }> => e.type === "output_progress",
  )

describe("estimateTokensFromChars (chars/4 parity with estimateTokens)", () => {
  test("ceils chars/4; clamps non-positive to 0", () => {
    expect(estimateTokensFromChars(0)).toBe(0)
    expect(estimateTokensFromChars(-5)).toBe(0)
    expect(estimateTokensFromChars(4)).toBe(1)
    expect(estimateTokensFromChars(5)).toBe(2) // ceil(5/4)
    expect(estimateTokensFromChars(400)).toBe(100)
  })
})

describe("withLiveUsage — default-OFF", () => {
  test("knob absent ⇒ returns the inner port VERBATIM (identity)", () => {
    const inner = mockPort([])
    expect(withLiveUsage(inner, undefined)).toBe(inner)
    expect(withLiveUsage(inner, {})).toBe(inner)
    expect(withLiveUsage(inner, { enabled: false })).toBe(inner)
  })

  test("disabled ⇒ stream is byte-identical (no output_progress injected)", async () => {
    const events: StreamEvent[] = [
      { type: "text_delta", delta: "hello world" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    const out = await drain(withLiveUsage(mockPort(events), { enabled: false }))
    expect(out).toEqual(events)
  })
})

describe("withLiveUsage — enabled", () => {
  test("preserves passthrough identity fields", () => {
    const wrapped = withLiveUsage(mockPort([], { model: "m", provider: "openai" }), {
      enabled: true,
    })
    expect(wrapped.model).toBe("m")
    expect(wrapped.provider).toBe("openai")
  })

  test("passes every inner event through, in order, untouched", async () => {
    const events: StreamEvent[] = [
      { type: "text_delta", delta: "abcd" },
      { type: "tool_use_start", id: "t1", name: "bash" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    const out = await drain(withLiveUsage(mockPort(events), { enabled: true }))
    // Every original event survives in order (progress events are interleaved).
    const passthrough: StreamEvent[] = out.filter((e) => e.type !== "output_progress")
    expect(passthrough).toEqual(events)
  })

  test("estimate path: text_delta drives a rising ~estimate (exact:false)", async () => {
    const events: StreamEvent[] = [
      { type: "text_delta", delta: "a".repeat(40) }, // 40 chars ⇒ 10 tokens
      { type: "text_delta", delta: "b".repeat(40) }, // +40 ⇒ 80 chars ⇒ 20 tokens
    ]
    const prog = progressOf(await drain(withLiveUsage(mockPort(events), { enabled: true })))
    expect(prog).toEqual([
      { type: "output_progress", outputTokens: 10, exact: false },
      { type: "output_progress", outputTokens: 20, exact: false },
    ])
  })

  test("thinking_delta also feeds the estimate (rises during 'thinking')", async () => {
    const events: StreamEvent[] = [{ type: "thinking_delta", text: "x".repeat(20) }] // 20 ⇒ 5 tokens
    const prog = progressOf(await drain(withLiveUsage(mockPort(events), { enabled: true })))
    expect(prog).toEqual([{ type: "output_progress", outputTokens: 5, exact: false }])
  })

  test("authoritative usage ⇒ exact:true and wins over a smaller estimate", async () => {
    const events: StreamEvent[] = [
      { type: "text_delta", delta: "a".repeat(20) }, // estimate 5
      { type: "usage", inputTokens: 100, outputTokens: 500, model: "m" }, // authoritative 500
    ]
    const prog = progressOf(await drain(withLiveUsage(mockPort(events), { enabled: true })))
    expect(prog).toEqual([
      { type: "output_progress", outputTokens: 5, exact: false },
      { type: "output_progress", outputTokens: 500, exact: true },
    ])
  })

  test("estimate extrapolates AHEAD of stale authoritative ⇒ exact flips false", async () => {
    const events: StreamEvent[] = [
      { type: "usage", inputTokens: 1, outputTokens: 10, model: "m" }, // auth 10
      { type: "text_delta", delta: "z".repeat(80) }, // estimate 20 > 10 ⇒ extrapolating
    ]
    const prog = progressOf(await drain(withLiveUsage(mockPort(events), { enabled: true })))
    expect(prog).toEqual([
      { type: "output_progress", outputTokens: 10, exact: true },
      { type: "output_progress", outputTokens: 20, exact: false },
    ])
  })

  test("inner output_progress (adapter exact) is absorbed as authoritative, no duplicate", async () => {
    const events: StreamEvent[] = [
      { type: "output_progress", outputTokens: 300, exact: true }, // adapter-emitted (e.g. Anthropic)
      { type: "text_delta", delta: "a".repeat(40) }, // estimate 10 < 300 ⇒ stays 300, exact
    ]
    const out = await drain(withLiveUsage(mockPort(events), { enabled: true }))
    const prog = progressOf(out)
    // The adapter's own progress passes through; the decorator does NOT emit a
    // duplicate for that tick. The later text_delta emits one (max=300, exact).
    expect(prog).toEqual([
      { type: "output_progress", outputTokens: 300, exact: true },
      { type: "output_progress", outputTokens: 300, exact: true },
    ])
  })

  test("no emit when the displayed count does not change", async () => {
    const events: StreamEvent[] = [
      { type: "text_delta", delta: "abc" }, // 3 chars ⇒ ceil(3/4)=1
      { type: "text_delta", delta: "d" }, // 4 chars ⇒ 1 (unchanged) ⇒ no emit
    ]
    const prog = progressOf(await drain(withLiveUsage(mockPort(events), { enabled: true })))
    expect(prog).toEqual([{ type: "output_progress", outputTokens: 1, exact: false }])
  })

  test("stream_reset (fallback switch) resets accumulators", async () => {
    const events: StreamEvent[] = [
      { type: "text_delta", delta: "a".repeat(40) }, // 10
      { type: "stream_reset" },
      { type: "text_delta", delta: "b".repeat(4) }, // fresh ⇒ 1, not 11
    ]
    const prog = progressOf(await drain(withLiveUsage(mockPort(events), { enabled: true })))
    expect(prog).toEqual([
      { type: "output_progress", outputTokens: 10, exact: false },
      { type: "output_progress", outputTokens: 1, exact: false },
    ])
  })

  test("tool_use_delta (streamed tool-call args) keeps the counter climbing", async () => {
    const events: StreamEvent[] = [
      { type: "tool_use_start", id: "t1", name: "bash" },
      { type: "tool_use_delta", id: "t1", delta: "x".repeat(40) }, // 40 chars ⇒ 10 tokens
      { type: "tool_use_delta", id: "t1", delta: "y".repeat(40) }, // 80 chars ⇒ 20 tokens
    ]
    const prog = progressOf(await drain(withLiveUsage(mockPort(events), { enabled: true })))
    expect(prog).toEqual([
      { type: "output_progress", outputTokens: 10, exact: false },
      { type: "output_progress", outputTokens: 20, exact: false },
    ])
  })

  test("a zero reading (usage output:0) emits nothing", async () => {
    const events: StreamEvent[] = [
      { type: "usage", inputTokens: 20, outputTokens: 0, model: "m" }, // initial 0 ⇒ noise
      { type: "text_delta", delta: "a".repeat(40) }, // first real motion ⇒ 10
    ]
    const prog = progressOf(await drain(withLiveUsage(mockPort(events), { enabled: true })))
    expect(prog).toEqual([{ type: "output_progress", outputTokens: 10, exact: false }])
  })

  test("exact upgrade surfaces even when the count is unchanged", async () => {
    const events: StreamEvent[] = [
      { type: "text_delta", delta: "a".repeat(40) }, // estimate 10 (false)
      { type: "usage", inputTokens: 1, outputTokens: 10, model: "m" }, // confirms 10 EXACTLY
    ]
    const prog = progressOf(await drain(withLiveUsage(mockPort(events), { enabled: true })))
    // Same value 10, but the exact:false → exact:true upgrade MUST emit so an
    // `output_progress`-only consumer sees the confirmed count.
    expect(prog).toEqual([
      { type: "output_progress", outputTokens: 10, exact: false },
      { type: "output_progress", outputTokens: 10, exact: true },
    ])
  })

  test("propagates a mid-stream throw (does not swallow)", async () => {
    const boom: LLMPort = {
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "text_delta", delta: "abcd" }
        throw new Error("mid-stream boom")
      },
    }
    const wrapped = withLiveUsage(boom, { enabled: true })
    await expect(drain(wrapped)).rejects.toThrow("mid-stream boom")
  })

  test("does NOT emit any usage events (accounting stays the loop's job)", async () => {
    const events: StreamEvent[] = [
      { type: "text_delta", delta: "a".repeat(40) },
      { type: "usage", inputTokens: 9, outputTokens: 9, model: "m" },
    ]
    const out = await drain(withLiveUsage(mockPort(events), { enabled: true }))
    // Exactly the ONE inner usage event — the decorator never synthesizes usage.
    expect(out.filter((e) => e.type === "usage")).toEqual([
      { type: "usage", inputTokens: 9, outputTokens: 9, model: "m" },
    ])
  })
})
