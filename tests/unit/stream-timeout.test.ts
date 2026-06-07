/**
 * T1 stream-hang guard — `withStreamTimeout` decorator tests.
 *
 * Pins the contract used by both adapters (`openai.ts` + `anthropic.ts`):
 *  1. First-chunk silence → `LLMError(kind:"stream_corrupt")` with message
 *     containing "first-chunk" and "timeout" (the latter is the substring the
 *     loop's `RETRYABLE_MARKERS` checks for so retry engages).
 *  2. Yield-one-then-hang silence → same error class with "idle" + "timeout".
 *  3. Yields-within-budget → passes through verbatim, no throw.
 *  4. On timeout the wrapper aborts the RAW stream's upstream cancellation
 *     handle (`.controller` / `.abort()`), so the provider request is really
 *     torn down instead of only flipping a disconnected local controller.
 *  5. Both adapters import the wrapper (source-level grep).
 *
 * Real timers are used: budgets are tiny (50–100 ms) so a passing test
 * completes in <500 ms.
 */
// source-grep allowed — T1 wiring suite below intentionally pins the
// `withStreamTimeout` import in both adapter sources so a refactor that rips
// the wrapper out of one adapter fails fast (per file header item 5).

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
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
  test("stream that yields nothing throws stream_corrupt with 'first-chunk' message", async () => {
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
    expect(err.kind).toBe("stream_corrupt")
    expect(err.provider).toBe("openai")
    expect(err.message).toContain("first-chunk")
    expect(err.message.toLowerCase()).toContain("timeout")
    expect(elapsed).toBeLessThan(500)
    expect((err.cause as Error | undefined)?.message ?? "").toContain("first-chunk")
  })
})

describe("withStreamTimeout — inter-chunk idle deadline", () => {
  test("yield one then hang forever throws stream_corrupt with 'idle' message", async () => {
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
    expect(err.kind).toBe("stream_corrupt")
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

describe("T1 wiring — both adapters use withStreamTimeout", () => {
  const root = resolve(__dirname, "../..")

  test("openai adapter imports + applies withStreamTimeout", () => {
    const src = readFileSync(resolve(root, "src/llm/adapters/openai.ts"), "utf8")
    expect(src).toContain("withStreamTimeout")
    expect(src).toContain('provider: "openai"')
  })

  test("anthropic adapter imports + applies withStreamTimeout", () => {
    const src = readFileSync(resolve(root, "src/llm/adapters/anthropic.ts"), "utf8")
    expect(src).toContain("withStreamTimeout")
    expect(src).toContain('provider: "anthropic"')
  })

  test("openai adapter forwards input.signal to SDK options AND timeout wrapper", () => {
    const src = readFileSync(resolve(root, "src/llm/adapters/openai.ts"), "utf8")
    expect(src).toContain("input.signal ? { signal: input.signal } : undefined")
    expect(src).toContain("...(input.signal ? { signal: input.signal } : {})")
  })

  test("anthropic adapter forwards input.signal to SDK options AND timeout wrapper", () => {
    const src = readFileSync(resolve(root, "src/llm/adapters/anthropic.ts"), "utf8")
    expect(src).toContain("input.signal ? { signal: input.signal } : undefined")
    expect(src).toContain("...(input.signal ? { signal: input.signal } : {})")
  })
})
