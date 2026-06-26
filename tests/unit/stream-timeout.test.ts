/**
 * T1 stream-hang guard — `withStreamTimeout` decorator tests.
 *
 * Pins the contract used by both adapters (`openai.ts` + `anthropic.ts`):
 *  1. First-chunk silence → a RETRYABLE `LLMError(kind:"network")` with message
 *     containing "first-chunk" and "timeout"; `isRetryable`/`classifyLLMError`
 *     match the `network` kind FIRST so the loop's same-turn retry engages (a
 *     timeout is a transient stall, NOT the fatal `stream_corrupt` shape-drift).
 *  2. Yield-one-then-hang silence → same error class with "idle" + "timeout".
 *  3. Yields-within-budget → passes through verbatim, no throw.
 *  4. On timeout the wrapper aborts the RAW stream's upstream cancellation
 *     handle (`.controller` / `.abort()`), so the provider request is really
 *     torn down instead of only flipping a disconnected local controller.
 *  5. Both adapters APPLY the wrapper with their own provider tag — proven
 *     behaviorally by driving the real adapter `.stream()` against an injected
 *     hung client (the "T1 wiring" suite), not by grepping the adapter source.
 *
 * Real timers are used: budgets are tiny (40–100 ms) so a passing test
 * completes in <500 ms.
 */

import { describe, expect, test } from "bun:test"
import { classifyLLMError, isRetryable } from "@/agent"
import type { StreamEvent, StreamInput } from "@/llm"
import { AnthropicAdapter } from "@/llm/adapters/anthropic"
import type { RawChunk } from "@/llm/adapters/openai"
import { OpenAIAdapter } from "@/llm/adapters/openai"
import {
  DEFAULT_FIRST_CHUNK_MS,
  DEFAULT_IDLE_MS,
  resolveStreamTimeoutMs,
  withStreamTimeout,
  withStreamTimeoutProbed,
} from "@/llm/stream-timeout"
import { LLMError } from "@/shared/errors"

/** Hand-rolled stub `AsyncIterable` whose `next()` resolves with the given
 *  chunks one at a time, with an optional delay AFTER the final value before
 *  going silent forever (simulates a hung stream). */
function makeStubStream<T>(opts: {
  chunks: T[]
  hangAfter?: boolean
  delayBeforeFirstMs?: number
  delayBetweenMs?: number
}): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      let i = 0
      return {
        async next(): Promise<IteratorResult<T>> {
          if (i === 0 && opts.delayBeforeFirstMs !== undefined) {
            await new Promise<void>((r) => setTimeout(r, opts.delayBeforeFirstMs))
          }
          if (i > 0 && opts.delayBetweenMs !== undefined) {
            await new Promise<void>((r) => setTimeout(r, opts.delayBetweenMs))
          }
          if (i >= opts.chunks.length) {
            if (opts.hangAfter) {
              // Hang forever — emulate a provider that opens the stream then
              // goes silent (the failure mode T1 closes).
              return new Promise<IteratorResult<T>>(() => {})
            }
            return { value: undefined as unknown as T, done: true }
          }
          const v = opts.chunks[i++] as T
          return { value: v, done: false }
        },
      }
    },
  }
}

function makeControllerBackedStream<T>(opts: {
  chunks: T[]
  hangAfter?: boolean
  delayBeforeFirstMs?: number
  delayBetweenMs?: number
}): AsyncIterable<T> & { controller: AbortController } {
  const base = makeStubStream(opts)
  const controller = new AbortController()
  return {
    controller,
    [Symbol.asyncIterator]: base[Symbol.asyncIterator].bind(base),
  }
}

describe("withStreamTimeout — first-chunk deadline", () => {
  test("stream that yields nothing throws a RETRYABLE network timeout with 'first-chunk' message", async () => {
    const stub = makeStubStream<number>({ chunks: [], hangAfter: true })
    const wrapped = withStreamTimeout(stub, {
      firstChunkMs: 50,
      idleMs: 9_999_000,
      provider: "openai",
    })

    let caught: unknown
    const t0 = Date.now()
    try {
      for await (const _ of wrapped) void _
    } catch (e) {
      caught = e
    }
    const elapsed = Date.now() - t0

    expect(caught).toBeInstanceOf(LLMError)
    const err = caught as LLMError
    expect(err.kind).toBe("network")
    // REGRESSION GUARD (jun-26): a timeout MUST classify retryable. Asserting on
    // the REAL thrown error (not a kind-less LLMError) is the coverage the prior
    // tests lacked — `kind:"stream_corrupt"` was FATAL and silently killed retry.
    expect(isRetryable(err)).toBe(true)
    expect(classifyLLMError(err)).toBe("retryable")
    expect(err.provider).toBe("openai")
    expect(err.message).toContain("first-chunk")
    expect(err.message.toLowerCase()).toContain("timeout")
    expect(elapsed).toBeLessThan(500)
    expect((err.cause as Error | undefined)?.message ?? "").toContain("first-chunk")
  })
})

describe("withStreamTimeout — abandoned iter.next() rejection is swallowed", () => {
  // jun-26 SE-audit: when the timeout WINS the race, the abandoned iter.next()
  // promise is still pending; if the torn-down stream later REJECTS it, that has
  // no handler → an unhandledRejection that can crash the process. The wrapper
  // attaches a no-op catch. This drives that exact path and asserts no
  // unhandledRejection escapes.
  test("a late rejection from the abandoned next() does NOT surface unhandledRejection", async () => {
    // A stream whose first next() rejects 120ms in — AFTER the 40ms timeout fires.
    const lateReject: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise<IteratorResult<number>>((_resolve, reject) =>
              setTimeout(() => reject(new Error("late upstream reject")), 120),
            ),
        }
      },
    }
    const seen: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      seen.push(reason)
    }
    process.on("unhandledRejection", onUnhandled)
    try {
      const wrapped = withStreamTimeout(lateReject, {
        firstChunkMs: 40,
        idleMs: 9_999_000,
        provider: "openai",
      })
      let threw = false
      try {
        for await (const _ of wrapped) void _
      } catch {
        threw = true // the timeout error — expected
      }
      expect(threw).toBe(true)
      // Wait past the late rejection (120ms) + a drain so any unhandled would fire.
      await new Promise<void>((r) => setTimeout(r, 220))
      const fromUs = seen.filter(
        (e) => e instanceof Error && e.message.includes("late upstream reject"),
      )
      expect(fromUs).toEqual([])
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })
})

describe("withStreamTimeout — inter-chunk idle deadline", () => {
  test("yield one then hang forever throws a RETRYABLE network timeout with 'idle' message", async () => {
    const stub = makeStubStream<string>({ chunks: ["a"], hangAfter: true })
    const wrapped = withStreamTimeout(stub, {
      firstChunkMs: 5_000,
      idleMs: 80,
      provider: "anthropic",
    })

    let caught: unknown
    const seen: string[] = []
    const t0 = Date.now()
    try {
      for await (const ch of wrapped) {
        seen.push(ch)
      }
    } catch (e) {
      caught = e
    }
    const elapsed = Date.now() - t0

    expect(seen).toEqual(["a"])
    expect(caught).toBeInstanceOf(LLMError)
    const err = caught as LLMError
    expect(err.kind).toBe("network")
    expect(isRetryable(err)).toBe(true)
    expect(classifyLLMError(err)).toBe("retryable")
    expect(err.provider).toBe("anthropic")
    expect(err.message).toContain("idle")
    expect(err.message.toLowerCase()).toContain("timeout")
    expect(elapsed).toBeLessThan(500)
    expect((err.cause as Error | undefined)?.message ?? "").toContain("idle")
  })
})

describe("withStreamTimeout — within-budget passthrough", () => {
  test("stream that finishes within budget passes every chunk through", async () => {
    const stub = makeStubStream<number>({ chunks: [1, 2, 3, 4, 5] })
    const wrapped = withStreamTimeout(stub, {
      firstChunkMs: 2_000,
      idleMs: 2_000,
      provider: "openai",
    })
    const got: number[] = []
    for await (const v of wrapped) got.push(v)
    expect(got).toEqual([1, 2, 3, 4, 5])
  })

  test("stream that yields slowly but inside the idle budget does not throw", async () => {
    const stub = makeStubStream<string>({
      chunks: ["x", "y", "z"],
      delayBetweenMs: 30,
    })
    const wrapped = withStreamTimeout(stub, {
      firstChunkMs: 500,
      idleMs: 500,
      provider: "anthropic",
    })
    const got: string[] = []
    for await (const v of wrapped) got.push(v)
    expect(got).toEqual(["x", "y", "z"])
  })
})

describe("withStreamTimeoutProbed — abort propagation", () => {
  test("on first-chunk timeout the raw stream controller signal is aborted", async () => {
    const stub = makeControllerBackedStream<number>({ chunks: [], hangAfter: true })
    let probedSignal: AbortSignal | undefined
    const wrapped = withStreamTimeoutProbed(stub, {
      firstChunkMs: 40,
      idleMs: 9_999_000,
      provider: "openai",
      onAbortHandle: (handle) => {
        probedSignal = handle?.signal
      },
    })

    let threw = false
    try {
      for await (const _ of wrapped) void _
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    expect(probedSignal).toBe(stub.controller.signal)
    expect(stub.controller.signal.aborted).toBe(true)
  })

  test("on idle timeout the raw stream controller signal is aborted", async () => {
    const stub = makeControllerBackedStream<string>({ chunks: ["only-one"], hangAfter: true })
    const wrapped = withStreamTimeoutProbed(stub, {
      firstChunkMs: 5_000,
      idleMs: 40,
      provider: "anthropic",
    })

    let threw = false
    const got: string[] = []
    try {
      for await (const v of wrapped) got.push(v)
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    expect(got).toEqual(["only-one"])
    expect(stub.controller.signal.aborted).toBe(true)
  })

  test("caller-supplied signal abort propagates to the raw stream controller", async () => {
    const stub = makeControllerBackedStream<number>({
      chunks: [1, 2, 3],
      delayBetweenMs: 100,
    })
    const caller = new AbortController()
    const wrapped = withStreamTimeoutProbed(stub, {
      firstChunkMs: 5_000,
      idleMs: 5_000,
      provider: "openai",
      signal: caller.signal,
    })

    setTimeout(() => caller.abort(new Error("user cancelled")), 50)

    try {
      for await (const _v of wrapped) {
        if (stub.controller.signal.aborted) break
      }
    } catch {
      // intentional
    }
    await new Promise<void>((r) => setTimeout(r, 60))
    expect(stub.controller.signal.aborted).toBe(true)
  })

  test("on timeout the wrapper calls rawStream.abort() when no controller is exposed", async () => {
    const base = makeStubStream<number>({ chunks: [], hangAfter: true })
    let abortCalls = 0
    const stub: AsyncIterable<number> & { abort(reason?: unknown): void } = {
      abort: () => {
        abortCalls += 1
      },
      [Symbol.asyncIterator]: base[Symbol.asyncIterator].bind(base),
    }
    const wrapped = withStreamTimeout(stub, {
      firstChunkMs: 40,
      idleMs: 9_999_000,
      provider: "openai",
    })

    let threw = false
    try {
      for await (const _ of wrapped) void _
    } catch {
      threw = true
    }

    expect(threw).toBe(true)
    expect(abortCalls).toBeGreaterThanOrEqual(1)
  })

  test("breaking the wrapped stream finalizes the upstream iterator", async () => {
    let returnCalls = 0
    const stub: AsyncIterable<number> = {
      [Symbol.asyncIterator](): AsyncIterator<number> {
        let i = 0
        return {
          async next() {
            if (i >= 3) return { value: undefined as unknown as number, done: true }
            i += 1
            return { value: i, done: false }
          },
          async return(value?: number) {
            returnCalls += 1
            return { value, done: true }
          },
        }
      },
    }
    const wrapped = withStreamTimeout(stub, {
      firstChunkMs: 5_000,
      idleMs: 5_000,
      provider: "openai",
    })

    for await (const value of wrapped) {
      expect(value).toBe(1)
      break
    }

    expect(returnCalls).toBeGreaterThanOrEqual(1)
  })
})

describe("resolveStreamTimeoutMs — precedence", () => {
  test("override > env > default", () => {
    expect(resolveStreamTimeoutMs(undefined, undefined)).toEqual({
      firstChunkMs: DEFAULT_FIRST_CHUNK_MS,
      idleMs: DEFAULT_IDLE_MS,
    })
    expect(resolveStreamTimeoutMs(5_000, 7_000)).toEqual({
      firstChunkMs: 5_000,
      idleMs: 7_000,
    })
    expect(resolveStreamTimeoutMs(5_000, 7_000, { firstChunkMs: 1_000, idleMs: 2_000 })).toEqual({
      firstChunkMs: 1_000,
      idleMs: 2_000,
    })
    expect(resolveStreamTimeoutMs(5_000, undefined, { idleMs: 2_000 })).toEqual({
      firstChunkMs: 5_000,
      idleMs: 2_000,
    })
  })

  test("defaults are generous (reasoning models can take 30s+ to first token)", () => {
    expect(DEFAULT_FIRST_CHUNK_MS).toBeGreaterThanOrEqual(30_000)
    expect(DEFAULT_IDLE_MS).toBeGreaterThanOrEqual(60_000)
  })
})

/**
 * T1 wiring — both adapters APPLY `withStreamTimeout` with their own provider
 * literal. Replaces the former source-grep proxies (which pinned the spelling
 * of `withStreamTimeout` / `provider: "openai"` and a format-pinned ternary)
 * with behavior: drive the REAL adapter `.stream()` against an injected client
 * whose raw stream opens and then goes silent forever, with a tiny
 * `streamFirstChunkMs`. If the wrapper were ripped out of an adapter — or wired
 * with the wrong provider tag — these would fail. A behavior-preserving refactor
 * (rename/extract/reflow) keeps them green.
 */
describe("T1 wiring — both adapters use withStreamTimeout", () => {
  const drainTo = async (it: AsyncIterable<StreamEvent>): Promise<void> => {
    for await (const _ of it) void _
  }

  /** An async-iterable that opens but never yields its first chunk. */
  const neverYielding = (): AsyncIterable<RawChunk> => ({
    [Symbol.asyncIterator]: (): AsyncIterator<RawChunk> => ({
      next: () => new Promise<IteratorResult<RawChunk>>(() => {}),
    }),
  })

  const baseStreamInput = (): StreamInput => ({
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
  })

  test("openai adapter applies withStreamTimeout with provider:'openai' (hung stream ⇒ retryable network timeout)", async () => {
    const a = new OpenAIAdapter({
      apiKey: "test",
      model: "gpt-x",
      maxTokens: 64,
      streamFirstChunkMs: 40,
    })
    ;(a as unknown as { client: { chat: { completions: { create: unknown } } } }).client = {
      chat: { completions: { create: async () => neverYielding() } },
    }

    let caught: unknown
    try {
      await drainTo(a.stream(baseStreamInput()))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(LLMError)
    const err = caught as LLMError
    expect(err.kind).toBe("network")
    expect(isRetryable(err)).toBe(true)
    expect(err.provider).toBe("openai")
    expect(err.message.toLowerCase()).toContain("timeout")
  })

  test("anthropic adapter applies withStreamTimeout with provider:'anthropic' (hung stream ⇒ retryable network timeout)", async () => {
    const a = new AnthropicAdapter({
      apiKey: "test",
      model: "claude-test",
      streamFirstChunkMs: 40,
    })
    ;(a as unknown as { client: { messages: { create: unknown } } }).client = {
      messages: { create: async () => neverYielding() },
    }

    let caught: unknown
    try {
      await drainTo(a.stream(baseStreamInput()))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(LLMError)
    const err = caught as LLMError
    expect(err.kind).toBe("network")
    expect(isRetryable(err)).toBe(true)
    expect(err.provider).toBe("anthropic")
    expect(err.message.toLowerCase()).toContain("timeout")
  })
})

/**
 * Behavioral coverage of the openai signal-forwarding wire (replaces the
 * former format-pinned source-grep). Drives the REAL `OpenAIAdapter.stream()`
 * against a local fake client that records the 2nd argument handed to
 * `chat.completions.create` (the SDK request-options), proving:
 *   - input.signal set  ⇒ create() receives exactly `{ signal: <that signal> }`
 *   - input.signal unset ⇒ create() receives `undefined`
 * The wrapper-half (signal composed into withStreamTimeout so an abort tears
 * the stream down) is already exercised behaviorally by the
 * "caller-supplied signal abort propagates …" probed test above; this closes
 * the create()/TTFT half through the real adapter symbol instead of grepping
 * its source spelling.
 */
describe("OpenAIAdapter — input.signal reaches the SDK create() options", () => {
  /** Fake OpenAI client capturing the 2nd arg of chat.completions.create. */
  class CapturingFakeOpenAI {
    capturedOpts: unknown
    createCalls = 0
    readonly chat = {
      completions: {
        create: async (_req: unknown, opts?: unknown): Promise<AsyncIterable<RawChunk>> => {
          this.createCalls += 1
          this.capturedOpts = opts
          const chunks: RawChunk[] = [
            { choices: [{ delta: { content: "hi" }, finish_reason: null }] },
            { choices: [{ delta: {}, finish_reason: "stop" }] },
          ]
          return {
            async *[Symbol.asyncIterator]() {
              for (const c of chunks) yield c
            },
          }
        },
      },
    }
  }

  const adapterWith = (fake: CapturingFakeOpenAI): OpenAIAdapter => {
    const a = new OpenAIAdapter({ apiKey: "test", model: "gpt-x", maxTokens: 64 })
    ;(a as unknown as { client: CapturingFakeOpenAI }).client = fake
    return a
  }

  const baseInput = (over: Partial<StreamInput> = {}): StreamInput => ({
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
    ...over,
  })

  const drain = async (it: AsyncIterable<StreamEvent>): Promise<void> => {
    for await (const _ of it) void _
  }

  test("input.signal is forwarded as { signal } to the SDK create() options", async () => {
    const fake = new CapturingFakeOpenAI()
    const ctrl = new AbortController()
    await drain(adapterWith(fake).stream(baseInput({ signal: ctrl.signal })))
    expect(fake.createCalls).toBe(1)
    expect(fake.capturedOpts).toEqual({ signal: ctrl.signal })
    expect((fake.capturedOpts as { signal: AbortSignal }).signal).toBe(ctrl.signal)
  })

  test("absent input.signal ⇒ create() options are undefined (byte-identical path)", async () => {
    const fake = new CapturingFakeOpenAI()
    await drain(adapterWith(fake).stream(baseInput()))
    expect(fake.createCalls).toBe(1)
    expect(fake.capturedOpts).toBeUndefined()
  })
})
