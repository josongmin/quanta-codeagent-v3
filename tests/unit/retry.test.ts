import { describe, expect, test } from "bun:test"
import { isRetryable, RetryingLLM } from "@/agent"
import type { LLMPort, StreamEvent } from "@/llm"
import { LLMError } from "@/shared"

/** Inner LLMPort whose stream() behavior is scripted per call. Each script
 *  entry is either a list of events to yield, or an error to throw, plus a
 *  flag for whether to yield one event before throwing (mid-stream failure). */
type Step =
  | { kind: "ok"; events: StreamEvent[] }
  | { kind: "throw"; error: unknown }
  | { kind: "throwAfterEvent"; error: unknown }

class ScriptedLLM implements LLMPort {
  calls = 0
  constructor(private readonly steps: Step[]) {}

  async *stream(): AsyncIterable<StreamEvent> {
    const step = this.steps[this.calls] ?? this.steps[this.steps.length - 1]
    this.calls += 1
    if (!step) return
    if (step.kind === "ok") {
      for (const ev of step.events) yield ev
      return
    }
    if (step.kind === "throwAfterEvent") {
      yield { type: "text_delta", delta: "partial" }
      throw step.error
    }
    throw step.error
  }
}

const transient = (): LLMError => new LLMError("HTTP 503 service overloaded")
const collect = async (it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

describe("isRetryable classification", () => {
  test("retryable: 429/5xx/timeout/ECONNRESET/overloaded/rate", () => {
    for (const m of [
      "429 Too Many Requests",
      "HTTP 503",
      "request timeout",
      "read ECONNRESET",
      "model overloaded",
      "rate limit exceeded",
    ]) {
      expect(isRetryable(new LLMError(m))).toBe(true)
    }
  })

  test("fatal: auth/400/404/malformed not retried", () => {
    for (const m of [
      "401 invalid api key",
      "400 invalid request",
      "404 not found",
      "malformed response",
      "403 unauthorized",
    ]) {
      expect(isRetryable(new LLMError(m))).toBe(false)
    }
  })

  test("non-LLMError is never retryable", () => {
    expect(isRetryable(new Error("503 overloaded"))).toBe(false)
    expect(isRetryable("503")).toBe(false)
  })
})

describe("RetryingLLM", () => {
  test("transient failure then success → retried, deterministic backoff sequence", async () => {
    const inner = new ScriptedLLM([
      { kind: "throw", error: transient() },
      { kind: "throw", error: transient() },
      { kind: "ok", events: [{ type: "message_stop", stop_reason: "end_turn" }] },
    ])
    const slept: number[] = []
    const r = new RetryingLLM({
      inner,
      baseDelayMs: 100,
      maxRetries: 4,
      sleep: async (ms) => {
        slept.push(ms)
      },
      random: () => 1, // full jitter upper bound → deterministic
    })

    const events = await collect(r.stream({ messages: [], tools: [] }))
    expect(events).toEqual([{ type: "message_stop", stop_reason: "end_turn" }])
    expect(inner.calls).toBe(3)
    // attempt 0 → floor(1*100)=99? floor(random()*exp); random=1 → exp-? .
    // exp(0)=100 → floor(1*100)=100; exp(1)=200 → 200.
    expect(slept).toEqual([100, 200])
  })

  test("mid-stream failure → NOT retried (would duplicate output)", async () => {
    const inner = new ScriptedLLM([{ kind: "throwAfterEvent", error: transient() }])
    const r = new RetryingLLM({ inner, sleep: async () => {}, random: () => 0 })
    await expect(collect(r.stream({ messages: [], tools: [] }))).rejects.toThrow()
    expect(inner.calls).toBe(1)
  })

  test("non-retryable error → not retried", async () => {
    const inner = new ScriptedLLM([{ kind: "throw", error: new LLMError("401 invalid api key") }])
    const r = new RetryingLLM({ inner, sleep: async () => {}, random: () => 0 })
    await expect(collect(r.stream({ messages: [], tools: [] }))).rejects.toThrow("401")
    expect(inner.calls).toBe(1)
  })

  test("exhausts maxRetries then rethrows", async () => {
    const inner = new ScriptedLLM([{ kind: "throw", error: transient() }])
    const r = new RetryingLLM({
      inner,
      maxRetries: 2,
      sleep: async () => {},
      random: () => 0,
    })
    await expect(collect(r.stream({ messages: [], tools: [] }))).rejects.toThrow()
    expect(inner.calls).toBe(3) // initial + 2 retries
  })

  test("abort during backoff → throws, stops retrying", async () => {
    const inner = new ScriptedLLM([{ kind: "throw", error: transient() }])
    const ac = new AbortController()
    const r = new RetryingLLM({
      inner,
      signal: ac.signal,
      sleep: async () => {
        ac.abort()
      },
      random: () => 0,
    })
    await expect(collect(r.stream({ messages: [], tools: [] }))).rejects.toThrow("aborted")
    expect(inner.calls).toBe(1)
  })

  // Regression: the CLI always wraps the adapter in RetryingLLM, so the loop's
  // pre-stream `llm_request` (RFC-0002 §5.2/§9) read `config.llm.model`
  // through THIS decorator. A live smoke caught it emitting `(unknown)`
  // because RetryingLLM didn't forward `inner.model` — unit tests had missed
  // the decorator entirely. Guard the forward + the exactOptional contract.
  test("forwards inner.model so the decorated chain reports a faithful model", () => {
    const withModel: LLMPort = { model: "gpt-4o", async *stream() {} }
    expect(new RetryingLLM({ inner: withModel }).model).toBe("gpt-4o")

    const noModel: LLMPort = { async *stream() {} }
    const r = new RetryingLLM({ inner: noModel })
    // exactOptionalPropertyTypes: absent, never an explicit `undefined`.
    expect("model" in r && r.model !== undefined).toBe(false)
  })
})
