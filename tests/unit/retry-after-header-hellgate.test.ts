import { describe, expect, test } from "bun:test"
import { backoffDelayMs, isRetryable, RetryingLLM } from "@/agent/retry"
import type { LLMPort, StreamEvent } from "@/llm"
import { LLMError, parseRetryAfterMs } from "@/shared"

/**
 * ADR-0208 hellgate — the agent's pre-stream retry must HONOR a server-provided
 * `retry-after` instruction instead of blind exponential backoff. A 429 already
 * told us when capacity returns; guessing a smaller delay just guarantees a
 * second 429 and burns the limited retry budget.
 *
 * Determinism: every case injects `sleep` (records the requested ms, never
 * actually waits) + `random: () => 1` (full-jitter upper bound), so we assert on
 * the COMPUTED delay — no real 30s sleep ever happens.
 */

type Step = { kind: "throw"; error: unknown } | { kind: "ok"; events: StreamEvent[] }

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
    throw step.error
  }
}

const collect = async (it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

/** Build the LLMError the boundary (`fromSdkError`) would produce for a 429 with
 *  the given response headers — exercised end-to-end through `fromSdkError` so
 *  we prove the parse + carry, not just an injected field. */
const sdkErrorWithHeaders = (headers: Record<string, string>): LLMError =>
  LLMError.fromSdkError("anthropic", { status: 429, headers, message: "rate limited" })

const ok: Step = { kind: "ok", events: [{ type: "message_stop", stop_reason: "end_turn" }] }

const newRetrying = (steps: Step[], slept: number[]): RetryingLLM =>
  new RetryingLLM({
    inner: new ScriptedLLM(steps),
    baseDelayMs: 100,
    maxRetries: 4,
    sleep: async (ms) => {
      slept.push(ms)
    },
    random: () => 1, // full-jitter upper bound → deterministic exponential
  })

describe("ADR-0208 parseRetryAfterMs (pure)", () => {
  const lookup =
    (h: Record<string, string>) =>
    (name: string): string | null =>
      h[name.toLowerCase()] ?? null

  test("retry-after delta-seconds integer → ms", () => {
    expect(parseRetryAfterMs(lookup({ "retry-after": "30" }))).toBe(30_000)
    expect(parseRetryAfterMs(lookup({ "retry-after": "0" }))).toBe(0)
  })

  test("retry-after HTTP-date → delta against now", () => {
    const now = 1_700_000_000_000
    const future = new Date(now + 45_000).toUTCString() // GMT date string
    expect(parseRetryAfterMs(lookup({ "retry-after": future }), () => now)).toBe(45_000)
  })

  test("retry-after HTTP-date in the past → undefined", () => {
    const now = 1_700_000_000_000
    const past = new Date(now - 10_000).toUTCString()
    expect(parseRetryAfterMs(lookup({ "retry-after": past }), () => now)).toBeUndefined()
  })

  test("retry-after-ms (explicit ms) takes precedence", () => {
    expect(parseRetryAfterMs(lookup({ "retry-after-ms": "1500", "retry-after": "30" }))).toBe(1500)
  })

  test("x-ratelimit-reset as absolute epoch-seconds → delta", () => {
    const now = 1_700_000_000_000 // ms
    const resetEpochSecs = 1_700_000_020 // 20s in the future
    expect(
      parseRetryAfterMs(lookup({ "x-ratelimit-reset": String(resetEpochSecs) }), () => now),
    ).toBe(20_000)
  })

  test("x-ratelimit-reset as small relative delta-seconds → ms", () => {
    expect(parseRetryAfterMs(lookup({ "x-ratelimit-reset": "12" }))).toBe(12_000)
  })

  test("malformed retry-after → undefined (caller falls back)", () => {
    expect(parseRetryAfterMs(lookup({ "retry-after": "soon" }))).toBeUndefined()
    expect(parseRetryAfterMs(lookup({ "retry-after": "-5" }))).toBeUndefined()
    expect(parseRetryAfterMs(lookup({ "retry-after": "" }))).toBeUndefined()
    expect(parseRetryAfterMs(lookup({}))).toBeUndefined()
  })
})

describe("ADR-0208 fromSdkError carries retryAfterMs", () => {
  test("429 + retry-after header → LLMError.retryAfterMs populated, kind=rate_limit", () => {
    const e = sdkErrorWithHeaders({ "retry-after": "30" })
    expect(e.kind).toBe("rate_limit")
    expect(e.retryAfterMs).toBe(30_000)
    expect(isRetryable(e)).toBe(true)
  })

  test("plain-record headers (Anthropic shape) parsed", () => {
    const e = sdkErrorWithHeaders({ "Retry-After": "5" }) // case-insensitive
    expect(e.retryAfterMs).toBe(5_000)
  })

  test("WHATWG Headers-like (.get) parsed", () => {
    const headers = new Headers({ "retry-after": "7" })
    const e = LLMError.fromSdkError("openai", { status: 429, headers, message: "rl" })
    expect(e.retryAfterMs).toBe(7_000)
  })

  test("no header → retryAfterMs absent (exactOptional: not even explicit undefined)", () => {
    const e = LLMError.fromSdkError("anthropic", { status: 429, message: "rl" })
    // exactOptionalPropertyTypes: never an explicit `undefined` (mirrors the
    // `model` guard in retry.test.ts).
    expect("retryAfterMs" in e && e.retryAfterMs !== undefined).toBe(false)
  })
})

describe("ADR-0208 RetryingLLM honors retry-after", () => {
  test("(a) 429 retry-after: 30 → backoff waits 30s-derived, not exponential", async () => {
    const slept: number[] = []
    const r = newRetrying(
      [{ kind: "throw", error: sdkErrorWithHeaders({ "retry-after": "30" }) }, ok],
      slept,
    )
    const events = await collect(r.stream({ messages: [], tools: [] }))
    expect(events).toEqual([{ type: "message_stop", stop_reason: "end_turn" }])
    // Server said 30s → honored verbatim, NOT the exponential 100ms.
    expect(slept).toEqual([30_000])
  })

  test("(b) HTTP-date retry-after → parsed + honored", async () => {
    // fromSdkError uses the real wall clock; build a date ~25s ahead of NOW so
    // the computed delta is a small positive window (robust to clock skew
    // between fromSdkError's Date.now() and these assertions). HTTP-date has
    // 1s resolution, so the floor of the window is 24s.
    const future = new Date(Date.now() + 25_000).toUTCString()
    const e = LLMError.fromSdkError("anthropic", {
      status: 429,
      headers: { "retry-after": future },
      message: "rl",
    })
    expect(e.retryAfterMs).toBeGreaterThan(20_000)
    expect(e.retryAfterMs).toBeLessThanOrEqual(26_000)
    const slept: number[] = []
    const r = newRetrying([{ kind: "throw", error: e }, ok], slept)
    await collect(r.stream({ messages: [], tools: [] }))
    expect(slept).toHaveLength(1)
    expect(slept[0]).toBeGreaterThan(20_000)
  })

  test("(c) no header → exponential fallback BYTE-IDENTICAL to backoffDelayMs", async () => {
    const transient = new LLMError("HTTP 503 overloaded") // no header, kind=unknown→marker retryable
    const slept: number[] = []
    const r = newRetrying(
      [{ kind: "throw", error: transient }, { kind: "throw", error: transient }, ok],
      slept,
    )
    await collect(r.stream({ messages: [], tools: [] }))
    // Reference: exactly what backoffDelayMs would compute with random()=1.
    expect(slept).toEqual([backoffDelayMs(0, 100, () => 1), backoffDelayMs(1, 100, () => 1)])
    expect(slept).toEqual([100, 200])
  })

  test("(d) retry-after beyond ceiling → clamped to 60s", async () => {
    // Year-ahead HTTP-date would compute a huge delta; must clamp.
    const huge = LLMError.fromSdkError("anthropic", {
      status: 429,
      headers: { "retry-after": "100000" }, // 100,000s
      message: "rl",
    })
    expect(huge.retryAfterMs).toBe(100_000_000)
    const slept: number[] = []
    const r = newRetrying([{ kind: "throw", error: huge }, ok], slept)
    await collect(r.stream({ messages: [], tools: [] }))
    expect(slept).toEqual([60_000]) // MAX_SERVER_DELAY_MS
  })

  test("(e) non-retryable (auth 401) → no retry regardless of header", async () => {
    // Even if a 401 somehow carried a retry-after, it must NOT retry.
    const auth = LLMError.fromSdkError("anthropic", {
      status: 401,
      headers: { "retry-after": "5" },
      message: "invalid api key",
    })
    expect(auth.kind).toBe("auth")
    expect(isRetryable(auth)).toBe(false)
    const slept: number[] = []
    const inner = new ScriptedLLM([{ kind: "throw", error: auth }])
    const r = new RetryingLLM({ inner, sleep: async (ms) => slept.push(ms), random: () => 1 })
    await expect(collect(r.stream({ messages: [], tools: [] }))).rejects.toThrow()
    expect(inner.calls).toBe(1) // no retry
    expect(slept).toEqual([]) // never slept
  })

  test("(f) malformed retry-after → ignored, falls back to exponential", async () => {
    const e = LLMError.fromSdkError("anthropic", {
      status: 429,
      headers: { "retry-after": "whenever" },
      message: "rl",
    })
    expect(e.retryAfterMs).toBeUndefined() // unparsable → absent
    expect(isRetryable(e)).toBe(true)
    const slept: number[] = []
    const r = newRetrying([{ kind: "throw", error: e }, ok], slept)
    await collect(r.stream({ messages: [], tools: [] }))
    expect(slept).toEqual([100]) // exponential attempt 0, NOT a server delay
  })
})
