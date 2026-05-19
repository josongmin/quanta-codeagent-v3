import { describe, expect, test } from "bun:test"
import { assembleFromEvents, FallbackLLM, isFallbackTrigger } from "@/llm"
import type { LLMPort, StreamEvent } from "@/llm"
import { LLMError } from "@/shared"

/** Inner LLMPort whose stream() behavior is scripted. A step is either a list
 *  of events to yield, an error to throw before yielding anything (pre-yield
 *  failure), or events-then-error (mid-stream failure). */
type Step =
  | { kind: "ok"; events: StreamEvent[] }
  | { kind: "throw"; error: unknown }
  | { kind: "yieldThenThrow"; events: StreamEvent[]; error: unknown }

class ScriptedLLM implements LLMPort {
  calls = 0
  constructor(private readonly step: Step) {}

  async *stream(): AsyncIterable<StreamEvent> {
    this.calls += 1
    if (this.step.kind === "ok") {
      for (const ev of this.step.events) yield ev
      return
    }
    if (this.step.kind === "yieldThenThrow") {
      for (const ev of this.step.events) yield ev
      throw this.step.error
    }
    throw this.step.error
  }
}

const overload = (): LLMError => new LLMError('overloaded_error: {"type":"overloaded_error"}')
const status529 = (): LLMError => Object.assign(new LLMError("HTTP 529"), { status: 529 })
const collect = async (it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}
const text = (t: string): StreamEvent => ({ type: "text_delta", delta: t })
const stop = (): StreamEvent => ({ type: "message_stop", stop_reason: "end_turn" })

describe("isFallbackTrigger classification", () => {
  test("trigger: 529 status / overloaded / provider-unavailable phrasings", () => {
    expect(isFallbackTrigger(status529())).toBe(true)
    for (const m of [
      'overloaded_error: {"type":"overloaded_error"}',
      "HTTP 529 overloaded",
      "Repeated 529 Overloaded errors",
      "503 service unavailable",
      "no healthy upstream",
      "upstream connect error",
    ]) {
      expect(isFallbackTrigger(new LLMError(m))).toBe(true)
    }
  })

  test("non-trigger: auth/client/shape errors are rethrown immediately", () => {
    for (const m of [
      "401 invalid api key",
      "400 invalid request",
      "404 not found",
      "malformed response",
      "403 unauthorized",
    ]) {
      expect(isFallbackTrigger(new LLMError(m))).toBe(false)
    }
  })

  test("non-trigger: plain transient (429/timeout) is not a provider swap", () => {
    expect(isFallbackTrigger(new LLMError("429 rate limit"))).toBe(false)
    expect(isFallbackTrigger(new LLMError("request timeout"))).toBe(false)
  })

  test("non-LLMError is never a trigger", () => {
    expect(isFallbackTrigger(new Error("529 overloaded"))).toBe(false)
    expect(isFallbackTrigger("529")).toBe(false)
  })
})

describe("FallbackLLM", () => {
  test("primary succeeds → no fallback used, no stream_reset", async () => {
    const primary = new ScriptedLLM({ kind: "ok", events: [text("hi"), stop()] })
    const fb = new ScriptedLLM({ kind: "ok", events: [text("nope")] })
    const llm = new FallbackLLM({ providers: [primary, fb] })

    const events = await collect(llm.stream({ messages: [], tools: [] }))
    expect(events).toEqual([text("hi"), stop()])
    expect(primary.calls).toBe(1)
    expect(fb.calls).toBe(0)
  })

  test("pre-yield swap is transparent (NO stream_reset)", async () => {
    const primary = new ScriptedLLM({ kind: "throw", error: status529() })
    const fb = new ScriptedLLM({ kind: "ok", events: [text("from-fb"), stop()] })
    const llm = new FallbackLLM({ providers: [primary, fb] })

    const events = await collect(llm.stream({ messages: [], tools: [] }))
    expect(events).toEqual([text("from-fb"), stop()])
    expect(events.some((e) => e.type === "stream_reset")).toBe(false)
    expect(primary.calls).toBe(1)
    expect(fb.calls).toBe(1)

    // assembled message is just the fallback content
    expect(assembleFromEvents(events).message).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "from-fb" }],
    })
  })

  test("post-yield swap emits stream_reset then fallback content; assemble keeps only fallback", async () => {
    const primary = new ScriptedLLM({
      kind: "yieldThenThrow",
      events: [text("DEAD-partial")],
      error: overload(),
    })
    const fb = new ScriptedLLM({
      kind: "ok",
      events: [text("clean "), text("fallback"), stop()],
    })
    const llm = new FallbackLLM({ providers: [primary, fb] })

    const events = await collect(llm.stream({ messages: [], tools: [] }))
    expect(events).toEqual([
      text("DEAD-partial"),
      { type: "stream_reset" },
      text("clean "),
      text("fallback"),
      stop(),
    ])

    // assembleFromEvents must drop the dead partial entirely.
    const { message } = assembleFromEvents(events)
    expect(message).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "clean fallback" }],
    })
  })

  test("only one stream_reset is emitted across multiple post-yield swaps", async () => {
    const p1 = new ScriptedLLM({
      kind: "yieldThenThrow",
      events: [text("dead1")],
      error: overload(),
    })
    const p2 = new ScriptedLLM({ kind: "throw", error: status529() })
    const p3 = new ScriptedLLM({ kind: "ok", events: [text("final"), stop()] })
    const llm = new FallbackLLM({ providers: [p1, p2, p3] })

    const events = await collect(llm.stream({ messages: [], tools: [] }))
    expect(events).toEqual([
      text("dead1"),
      { type: "stream_reset" },
      text("final"),
      stop(),
    ])
    expect(events.filter((e) => e.type === "stream_reset")).toHaveLength(1)
    expect(assembleFromEvents(events).message.content).toEqual([
      { type: "text", text: "final" },
    ])
  })

  test("all providers fail with trigger → rethrows the LAST error", async () => {
    const lastErr = new LLMError("529 overloaded (last)")
    const p1 = new ScriptedLLM({ kind: "throw", error: overload() })
    const p2 = new ScriptedLLM({ kind: "throw", error: lastErr })
    const llm = new FallbackLLM({ providers: [p1, p2] })

    await expect(collect(llm.stream({ messages: [], tools: [] }))).rejects.toBe(lastErr)
    expect(p1.calls).toBe(1)
    expect(p2.calls).toBe(1)
  })

  test("non-fallback error → rethrown immediately, no further provider tried", async () => {
    const p1 = new ScriptedLLM({ kind: "throw", error: new LLMError("401 invalid api key") })
    const p2 = new ScriptedLLM({ kind: "ok", events: [text("never")] })
    const llm = new FallbackLLM({ providers: [p1, p2] })

    await expect(collect(llm.stream({ messages: [], tools: [] }))).rejects.toThrow("401")
    expect(p1.calls).toBe(1)
    expect(p2.calls).toBe(0)
  })

  test("mid-stream non-fallback error → rethrown, no stream_reset / no swap", async () => {
    const p1 = new ScriptedLLM({
      kind: "yieldThenThrow",
      events: [text("partial")],
      error: new LLMError("malformed response"),
    })
    const p2 = new ScriptedLLM({ kind: "ok", events: [text("never")] })
    const llm = new FallbackLLM({ providers: [p1, p2] })

    await expect(collect(llm.stream({ messages: [], tools: [] }))).rejects.toThrow("malformed")
    expect(p2.calls).toBe(0)
  })

  test("abort before primary attempt → throws, nothing streamed", async () => {
    const ac = new AbortController()
    ac.abort()
    const p1 = new ScriptedLLM({ kind: "ok", events: [text("x")] })
    const llm = new FallbackLLM({ providers: [p1], signal: ac.signal })

    await expect(collect(llm.stream({ messages: [], tools: [] }))).rejects.toThrow("aborted")
    expect(p1.calls).toBe(0)
  })

  test("abort respected before the fallback attempt", async () => {
    const ac = new AbortController()
    const p1 = new ScriptedLLM({ kind: "throw", error: status529() })
    const p2 = new ScriptedLLM({ kind: "ok", events: [text("never")] })
    // Custom trigger that aborts as a side effect, simulating user interrupt
    // between the primary failure and the fallback attempt.
    const llm = new FallbackLLM({
      providers: [p1, p2],
      signal: ac.signal,
      isFallbackTrigger: (e) => {
        ac.abort()
        return isFallbackTrigger(e)
      },
    })

    await expect(collect(llm.stream({ messages: [], tools: [] }))).rejects.toThrow("aborted")
    expect(p1.calls).toBe(1)
    expect(p2.calls).toBe(0)
  })

  test("empty provider list is rejected at construction", () => {
    expect(() => new FallbackLLM({ providers: [] })).toThrow("at least one provider")
  })

  test("custom isFallbackTrigger override is honored", async () => {
    const sentinel = new LLMError("teapot-418")
    const p1 = new ScriptedLLM({ kind: "throw", error: sentinel })
    const p2 = new ScriptedLLM({ kind: "ok", events: [text("ok"), stop()] })
    const llm = new FallbackLLM({
      providers: [p1, p2],
      isFallbackTrigger: (e) => e === sentinel,
    })

    const events = await collect(llm.stream({ messages: [], tools: [] }))
    expect(events).toEqual([text("ok"), stop()])
    expect(p2.calls).toBe(1)
  })
})
