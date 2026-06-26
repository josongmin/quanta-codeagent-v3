/**
 * TDD — consecutive-empty-stream circuit breaker (jun-26).
 *
 * CONFIRMED bug (cassette /tmp/g55-traj.jsonl, records #2-5): a bench repro-test
 * turn received a content-LESS stream — the adapter emitted only the
 * `{type:"llm_continuation", phase:"prepare", reason:"no_prompt_cache_key"}`
 * telemetry event and then NO content arrived, so the inter-chunk idle timeout
 * tripped. That timeout is classified transient, so the SAME request (identical
 * request-hash) was retried; each retry burned the FULL idle window producing
 * zero content. With the default 120s idle this silently burns many minutes.
 *
 * The guard: a `LLMPort` decorator that counts CONSECUTIVE content-less streams
 * for the same route and, after K (default 2), throws a TERMINAL (non-retryable)
 * error instead of letting the transient-retry path loop forever. The first
 * content event resets the counter. A healthy (content-producing) stream is
 * passed through byte-identically and never trips the breaker.
 */
import { describe, expect, mock, test } from "bun:test"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { LLMError } from "@/shared"
import {
  DEFAULT_EMPTY_STREAM_BREAKER_K,
  EMPTY_STREAM_BREAKER_ERROR_MARKER,
  isStreamEventContentful,
  withEmptyStreamCircuitBreaker,
} from "./empty-stream-breaker"

const TELEMETRY_CONTINUATION: StreamEvent = {
  type: "llm_continuation",
  surfaceId: "openai-responses",
  transportId: "chatgpt-oauth",
  phase: "prepare",
  mode: "full",
  reason: "no_prompt_cache_key",
}

/** A scripted port whose `stream()` yields a fixed event list per call. Each
 *  call records that it was invoked so a test can bound the call count. */
class ScriptedPort implements LLMPort {
  readonly model = "scripted"
  calls = 0
  constructor(private readonly scripts: StreamEvent[][]) {}
  stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    const idx = this.calls
    this.calls += 1
    const events = this.scripts[Math.min(idx, this.scripts.length - 1)] ?? []
    async function* gen(): AsyncIterable<StreamEvent> {
      for (const ev of events) yield ev
    }
    return gen()
  }
}

const collect = async (it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

const REQ: StreamInput = {
  messages: [{ role: "user", content: [{ type: "text", text: "write a repro test" }] }],
  tools: [],
}

describe("isStreamEventContentful — content vs telemetry classification", () => {
  test("telemetry events are NOT content (llm_continuation / usage / message_stop / progress)", () => {
    expect(isStreamEventContentful(TELEMETRY_CONTINUATION)).toBe(false)
    expect(
      isStreamEventContentful({
        type: "usage",
        inputTokens: 1,
        outputTokens: 0,
        model: "m",
      }),
    ).toBe(false)
    expect(isStreamEventContentful({ type: "message_stop", stop_reason: "end_turn" })).toBe(false)
    expect(isStreamEventContentful({ type: "output_progress", outputTokens: 5, exact: false })).toBe(
      false,
    )
    expect(isStreamEventContentful({ type: "response_in_progress" })).toBe(false)
    expect(isStreamEventContentful({ type: "stream_reset" })).toBe(false)
  })

  test("text / tool / thinking deltas ARE content", () => {
    expect(isStreamEventContentful({ type: "text_delta", delta: "x" })).toBe(true)
    expect(isStreamEventContentful({ type: "thinking_delta", text: "x" })).toBe(true)
    expect(isStreamEventContentful({ type: "tool_use_start", id: "1", name: "edit" })).toBe(true)
    expect(isStreamEventContentful({ type: "tool_use_delta", id: "1", delta: "{" })).toBe(true)
    expect(isStreamEventContentful({ type: "tool_use_end", id: "1", input: {} })).toBe(true)
  })
})

describe("withEmptyStreamCircuitBreaker — consecutive content-less streams trip a terminal", () => {
  test("K consecutive content-LESS streams (telemetry only) throw a TERMINAL non-retryable error, bounded", async () => {
    // The cassette case: every call emits ONLY the llm_continuation telemetry.
    const inner = new ScriptedPort([[TELEMETRY_CONTINUATION]])
    const guarded = withEmptyStreamCircuitBreaker(inner, { maxConsecutiveEmpty: 2 })

    // Attempt 1: empty stream — passes through (counter = 1), no throw yet.
    const first = await collect(guarded.stream(REQ))
    expect(first).toEqual([TELEMETRY_CONTINUATION])

    // Attempt 2: SECOND consecutive empty stream — the breaker trips DURING/at the
    // end of this stream with a terminal error.
    let thrown: unknown
    try {
      await collect(guarded.stream(REQ))
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(LLMError)
    const err = thrown as LLMError
    // Terminal: kind must be a FATAL (never-retry) kind so the transient-retry
    // path does NOT loop it. `bad_request` is in src/agent/retry.ts FATAL_KINDS.
    expect(err.kind).toBe("bad_request")
    expect(err.message).toContain(EMPTY_STREAM_BREAKER_ERROR_MARKER)
    // N consecutive empties surfaced in the "N consecutive empty streams" prefix
    // (robust against the route hash, which may itself contain a digit).
    expect(err.message).toMatch(/\b2 consecutive empty streams \(no content\)/)

    // BOUNDED: the inner port was hit exactly twice — NOT looped forever.
    expect(inner.calls).toBe(2)
  })

  test("red-on-injection — with the breaker DISABLED (K=Infinity) the same stub never throws (proves the guard, not the stub, trips it)", async () => {
    const inner = new ScriptedPort([[TELEMETRY_CONTINUATION]])
    const disabled = withEmptyStreamCircuitBreaker(inner, {
      maxConsecutiveEmpty: Number.POSITIVE_INFINITY,
    })
    // Many consecutive empties with the guard disabled — NONE throw.
    for (let i = 0; i < 6; i++) {
      const evs = await collect(disabled.stream(REQ))
      expect(evs).toEqual([TELEMETRY_CONTINUATION])
    }
    expect(inner.calls).toBe(6)
  })

  test("HEALTHY path — a content-producing stream passes through byte-identically and never trips", async () => {
    const healthy: StreamEvent[] = [
      TELEMETRY_CONTINUATION,
      { type: "text_delta", delta: "FILE" },
      { type: "text_delta", delta: ": x.py" },
      { type: "usage", inputTokens: 10, outputTokens: 2, model: "m" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    const inner = new ScriptedPort([healthy])
    const guarded = withEmptyStreamCircuitBreaker(inner, { maxConsecutiveEmpty: 2 })
    // Run it MORE times than K — content resets the counter every time, so it
    // never trips no matter how many healthy streams in a row.
    for (let i = 0; i < 5; i++) {
      const evs = await collect(guarded.stream(REQ))
      expect(evs).toEqual(healthy) // byte-identical pass-through
    }
    expect(inner.calls).toBe(5)
  })

  test("content RESETS the counter — empty, then content, then empty does NOT trip", async () => {
    const empty = [TELEMETRY_CONTINUATION]
    const withContent = [TELEMETRY_CONTINUATION, { type: "text_delta", delta: "ok" } as StreamEvent]
    const inner = new ScriptedPort([empty, withContent, empty])
    const guarded = withEmptyStreamCircuitBreaker(inner, { maxConsecutiveEmpty: 2 })

    await collect(guarded.stream(REQ)) // empty   → counter 1
    await collect(guarded.stream(REQ)) // content → counter reset to 0
    // empty again → counter 1 (NOT 2), so NO throw.
    const third = await collect(guarded.stream(REQ))
    expect(third).toEqual(empty)
    expect(inner.calls).toBe(3)
  })

  test("a per-route key separates routes — empties on route A do not trip route B", async () => {
    const inner = new ScriptedPort([[TELEMETRY_CONTINUATION]])
    const guarded = withEmptyStreamCircuitBreaker(inner, {
      maxConsecutiveEmpty: 2,
      routeKey: (input) => (input.system ?? "") as string,
    })
    const reqA: StreamInput = { ...REQ, system: "route-A" }
    const reqB: StreamInput = { ...REQ, system: "route-B" }
    await collect(guarded.stream(reqA)) // A: 1
    await collect(guarded.stream(reqB)) // B: 1 (independent)
    // A again → A:2 → trips; B is still at 1.
    await expect(collect(guarded.stream(reqA))).rejects.toBeInstanceOf(LLMError)
  })

  test("optional backoff is awaited BETWEEN empty streams (not hammering a throttling endpoint)", async () => {
    const inner = new ScriptedPort([[TELEMETRY_CONTINUATION]])
    const sleep = mock(async (_ms: number) => {})
    const guarded = withEmptyStreamCircuitBreaker(inner, {
      maxConsecutiveEmpty: 3,
      backoffMs: 50,
      sleep,
    })
    await collect(guarded.stream(REQ)) // empty #1 → schedule backoff before next
    await collect(guarded.stream(REQ)) // empty #2 → backoff applied at stream open
    // Backoff fired before the 2nd attempt (one prior empty in the route).
    expect(sleep).toHaveBeenCalledWith(50)
  })

  test("a thrown empty stream (idle timeout) ALSO counts toward the breaker", async () => {
    // Model the cassette literally: the inner stream throws the idle-timeout
    // LLMError after emitting only telemetry. The breaker must still count it as
    // an empty stream and trip after K — re-throwing the breaker's terminal so
    // the transient-retry path stops.
    class ThrowingEmptyPort implements LLMPort {
      readonly model = "scripted"
      calls = 0
      stream(): AsyncIterable<StreamEvent> {
        this.calls += 1
        async function* gen(): AsyncIterable<StreamEvent> {
          yield TELEMETRY_CONTINUATION
          throw new LLMError("LLM stream idle timeout after 120000ms (no data between chunks)", {
            kind: "stream_corrupt",
            provider: "chatgpt-oauth",
          })
        }
        return gen()
      }
    }
    const inner = new ThrowingEmptyPort()
    const guarded = withEmptyStreamCircuitBreaker(inner, { maxConsecutiveEmpty: 2 })

    // Attempt 1: telemetry then throw → the original idle-timeout error surfaces
    // (still transient on attempt 1), counter incremented to 1.
    await expect(collect(guarded.stream(REQ))).rejects.toMatchObject({ kind: "stream_corrupt" })
    // Attempt 2: second consecutive empty → breaker trips with its TERMINAL error.
    await expect(collect(guarded.stream(REQ))).rejects.toMatchObject({ kind: "bad_request" })
    expect(inner.calls).toBe(2)
  })

  test("default K constant is small (2) and exported", () => {
    expect(DEFAULT_EMPTY_STREAM_BREAKER_K).toBe(2)
  })
})
