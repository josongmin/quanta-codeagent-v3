import { describe, expect, test } from "bun:test"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { withTemperature } from "@/llm"

/** Fake LLMPort recording the input it was streamed with and yielding a fixed
 *  scripted event list, so we can assert injection + pass-through. */
class ScriptedLLM implements LLMPort {
  calls = 0
  lastInput: StreamInput | undefined
  constructor(
    readonly model: string,
    private readonly events: StreamEvent[] = [],
  ) {}

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    this.lastInput = input
    for (const ev of this.events) yield ev
  }
}

const collect = async (it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

const baseInput: StreamInput = { messages: [], tools: [] }

describe("withTemperature", () => {
  test("(a) injects the temperature when input has none", async () => {
    const inner = new ScriptedLLM("m")
    const wrapped = withTemperature(inner, 0.8)
    await collect(wrapped.stream(baseInput))
    expect(inner.lastInput?.temperature).toBe(0.8)
  })

  test("(b) respects a caller override — caller-set temperature wins", async () => {
    const inner = new ScriptedLLM("m")
    const wrapped = withTemperature(inner, 0.8)
    await collect(wrapped.stream({ ...baseInput, temperature: 0.2 }))
    expect(inner.lastInput?.temperature).toBe(0.2)
  })

  test("(b') a caller-set 0 is respected (not treated as absent)", async () => {
    const inner = new ScriptedLLM("m")
    const wrapped = withTemperature(inner, 0.8)
    await collect(wrapped.stream({ ...baseInput, temperature: 0 }))
    // 0 is a real override; injecting 0.8 here would be a falsy-check bug.
    expect(inner.lastInput?.temperature).toBe(0)
  })

  test("(c) delegates descriptive fields to inner verbatim", () => {
    const inner = Object.assign(new ScriptedLLM("claude-x"), {
      provider: "anthropic",
      surfaceId: "anthropic-messages" as const,
      transportId: "public" as const,
      authMode: "Anthropic BYOK",
      contextWindowKey: "claude-x-1m",
    })
    const wrapped = withTemperature(inner, 0.8)
    expect(wrapped.model).toBe("claude-x")
    expect(wrapped.provider).toBe("anthropic")
    expect(wrapped.surfaceId).toBe("anthropic-messages")
    expect(wrapped.transportId).toBe("public")
    expect(wrapped.authMode).toBe("Anthropic BYOK")
    expect(wrapped.contextWindowKey).toBe("claude-x-1m")
  })

  test("(d) passes the event stream through unchanged", async () => {
    const events: StreamEvent[] = [
      { type: "text_delta", delta: "hello" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    const inner = new ScriptedLLM("m", events)
    const wrapped = withTemperature(inner, 0.8)
    const out = await collect(wrapped.stream(baseInput))
    expect(out).toEqual(events)
    expect(inner.calls).toBe(1)
  })

  test("does not mutate the caller's input object (pure)", async () => {
    const inner = new ScriptedLLM("m")
    const wrapped = withTemperature(inner, 0.8)
    const input: StreamInput = { ...baseInput }
    await collect(wrapped.stream(input))
    expect("temperature" in input).toBe(false)
  })

  test("forwards other StreamInput fields alongside the injected temperature", async () => {
    const inner = new ScriptedLLM("m")
    const wrapped = withTemperature(inner, 0.8)
    await collect(
      wrapped.stream({ ...baseInput, promptCacheKey: "k1", toolChoice: { kind: "any" } }),
    )
    expect(inner.lastInput?.promptCacheKey).toBe("k1")
    expect(inner.lastInput?.toolChoice).toEqual({ kind: "any" })
    expect(inner.lastInput?.temperature).toBe(0.8)
  })
})
