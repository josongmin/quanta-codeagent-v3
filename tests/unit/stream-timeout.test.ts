/**
 * T1 stream-hang guard — `withStreamTimeout` decorator tests.
 *
 * Pins the contract used by both adapters (`openai.ts` + `anthropic.ts`):
 *  1. First-chunk silence → `LLMError(kind:"stream_corrupt")` with message
 *     containing "first-chunk" and "timeout" (the latter is the substring the
 *     loop's `RETRYABLE_MARKERS` checks for so retry engages).
 *  2. Yield-one-then-hang silence → same error class with "idle" + "timeout".
 *  3. Yields-within-budget → passes through verbatim, no throw.
 *  4. On timeout the wrapper's internal AbortController fires so the upstream
 *     SDK fetch is cancelled (probe asserts `.signal.aborted`).
 *  5. Both adapters import the wrapper (source-level grep).
 *
 * Real timers are used: budgets are tiny (50–100 ms) so a passing test
 * completes in <500 ms.
 */
// source-grep allowed — T1 wiring suite below intentionally pins the
// `withStreamTimeout` import in both adapter sources so a refactor that rips
// the wrapper out of one adapter fails fast (per file header item 5).
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, test } from "bun:test"
import { LLMError } from "@/shared/errors"
import {
  DEFAULT_FIRST_CHUNK_MS,
  DEFAULT_IDLE_MS,
  resolveStreamTimeoutMs,
  withStreamTimeout,
  withStreamTimeoutProbed,
} from "@/llm/stream-timeout"

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
      let firstYielded = false
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
          firstYielded = true
          return { value: v, done: false }
        },
      }
    },
  }
}

describe("withStreamTimeout — first-chunk deadline", () => {
  test("stream that yields nothing throws stream_corrupt with 'first-chunk' message", async () => {
    // Stream never yields and never ends: only the first-chunk deadline can
    // resolve the race. With firstChunkMs=50 we expect a throw in ~50 ms.
    const stub = makeStubStream<number>({ chunks: [], hangAfter: true })
    const wrapped = withStreamTimeout(stub, {
      firstChunkMs: 50,
      idleMs: 9_999_000,
      provider: "openai",
    })

    let caught: unknown
    const t0 = Date.now()
    try {
      // eslint-disable-next-line no-restricted-syntax
      for await (const _ of wrapped) {
        // unreachable
      }
    } catch (e) {
      caught = e
    }
    const elapsed = Date.now() - t0

    expect(caught).toBeInstanceOf(LLMError)
    const err = caught as LLMError
    expect(err.kind).toBe("stream_corrupt")
    expect(err.provider).toBe("openai")
    expect(err.message).toContain("first-chunk")
    // Message must contain "timeout" so the loop's RETRYABLE_MARKERS hits and
    // `classifyLLMError` returns "retryable" (existing same-turn retry path).
    expect(err.message.toLowerCase()).toContain("timeout")
    // Should fire near the deadline, not after the wall-clock budget for the
    // FOREVER-hung promise (which would mean the race didn't work).
    expect(elapsed).toBeLessThan(500)
    // `cause` records WHICH timeout fired (diagnostic surfacing).
    expect((err.cause as Error | undefined)?.message ?? "").toContain("first-chunk")
  })
})

describe("withStreamTimeout — inter-chunk idle deadline", () => {
  test("yield one then hang forever throws stream_corrupt with 'idle' message", async () => {
    // One chunk lands fast, then the stream hangs. firstChunk deadline is
    // generous so it MUST be the idle deadline that fires.
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
      idleMs: 500, // generous vs the 30 ms between chunks
      provider: "anthropic",
    })
    const got: string[] = []
    for await (const v of wrapped) got.push(v)
    expect(got).toEqual(["x", "y", "z"])
  })
})

describe("withStreamTimeoutProbed — abort propagation", () => {
  test("on first-chunk timeout the internal controller signal is aborted", async () => {
    const stub = makeStubStream<number>({ chunks: [], hangAfter: true })
    let controller: AbortController | undefined
    const wrapped = withStreamTimeoutProbed(stub, {
      firstChunkMs: 40,
      idleMs: 9_999_000,
      provider: "openai",
      onController: (c) => {
        controller = c
      },
    })

    let threw = false
    try {
      // eslint-disable-next-line no-restricted-syntax
      for await (const _ of wrapped) {
        // unreachable
      }
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    expect(controller).toBeDefined()
    // The wrapper must have aborted the upstream-cancellation signal so the
    // SDK fetch is torn down (no orphan request).
    expect(controller?.signal.aborted).toBe(true)
  })

  test("on idle timeout the internal controller signal is aborted", async () => {
    const stub = makeStubStream<string>({ chunks: ["only-one"], hangAfter: true })
    let controller: AbortController | undefined
    const wrapped = withStreamTimeoutProbed(stub, {
      firstChunkMs: 5_000,
      idleMs: 40,
      provider: "anthropic",
      onController: (c) => {
        controller = c
      },
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
    expect(controller?.signal.aborted).toBe(true)
  })

  test("caller-supplied signal abort propagates to the internal controller", async () => {
    // Long-running stream that would otherwise keep yielding; the external
    // signal trips, the internal controller MUST mirror that abort so the SDK
    // fetch tears down too.
    const stub = makeStubStream<number>({
      chunks: [1, 2, 3],
      delayBetweenMs: 100,
    })
    const caller = new AbortController()
    let internal: AbortController | undefined
    const wrapped = withStreamTimeoutProbed(stub, {
      firstChunkMs: 5_000,
      idleMs: 5_000,
      provider: "openai",
      signal: caller.signal,
      onController: (c) => {
        internal = c
      },
    })

    setTimeout(() => caller.abort(new Error("user cancelled")), 50)

    try {
      for await (const _v of wrapped) {
        // consume until silently interrupted; the stub will keep yielding,
        // so we break ourselves once internal aborts.
        if (internal?.signal.aborted) break
      }
    } catch {
      // intentional
    }
    // give the event loop one tick for the addEventListener handler.
    await new Promise<void>((r) => setTimeout(r, 60))
    expect(internal?.signal.aborted).toBe(true)
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
    expect(
      resolveStreamTimeoutMs(5_000, 7_000, { firstChunkMs: 1_000, idleMs: 2_000 }),
    ).toEqual({
      firstChunkMs: 1_000,
      idleMs: 2_000,
    })
    // Partial override merges with env / default for the missing side.
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
  // Source-level pin: if a future refactor accidentally rips the wrapper out
  // of one adapter, this test fails fast. This is the integration contract:
  // the user explicitly called out that wiring only ONE adapter is a fail.
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

  // Caller-cancellation threading (source-level pin): each adapter MUST forward
  // the incoming StreamInput.signal in TWO places — into the SDK request
  // options (aborts create()/TTFT) AND into the withStreamTimeout wrapper
  // (composes with the timeout controller, aborts the post-create() stream).
  // If a refactor drops either, an in-flight model stream stops aborting on
  // user cancel and the socket hangs — the exact bug this fix closes. The
  // source-level assertion is the right granularity: the adapters construct a
  // real SDK client internally (no injection seam), so a behavioural mock would
  // require inventing one; the wrapper's own caller-signal→controller
  // propagation is already proven behaviourally above.
  test("openai adapter forwards input.signal to SDK options AND timeout wrapper", () => {
    const src = readFileSync(resolve(root, "src/llm/adapters/openai.ts"), "utf8")
    // SDK request options: second arg to chat.completions.create.
    expect(src).toContain("input.signal ? { signal: input.signal } : undefined")
    // Timeout wrapper composition.
    expect(src).toContain("...(input.signal ? { signal: input.signal } : {})")
  })

  test("anthropic adapter forwards input.signal to SDK options AND timeout wrapper", () => {
    const src = readFileSync(resolve(root, "src/llm/adapters/anthropic.ts"), "utf8")
    // SDK request options: second arg to messages.create.
    expect(src).toContain("input.signal ? { signal: input.signal } : undefined")
    // Timeout wrapper composition.
    expect(src).toContain("...(input.signal ? { signal: input.signal } : {})")
  })
})
