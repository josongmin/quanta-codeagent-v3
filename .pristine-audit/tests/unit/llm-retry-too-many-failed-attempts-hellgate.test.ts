/**
 * Hellgate for `src/llm/retry/too-many-failed-attempts.ts` (ADR-0237 slice A).
 *
 * Pins the `tooManyFailedAttempts` layer-owned LLMErrorKind arm. 18 hard
 * cases in five blocks:
 *
 *   A. default-OFF byte-identical                       (HELL-A1..A3)
 *   B. counter semantics (N-1 / N / N+1 / reset)        (HELL-B4..B9)
 *   C. mid-stream throws DO NOT increment               (HELL-C10..C11)
 *   D. wrap preserves provider / statusCode / cause     (HELL-D12..D14)
 *   E. knob clamps + edge cases                         (HELL-E15..E18)
 *
 * Hermetic: hand-rolled in-memory fake LLMPort. NO real provider, no real
 * network, no timer dependency.
 */

import { describe, expect, test } from "bun:test"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import {
  __test,
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  withFailureCounter,
} from "@/llm/retry/too-many-failed-attempts"
import { LLMError } from "@/shared"

/* ------------------------------------------------------------------ */
/* hand-rolled fake LLMPort                                            */
/* ------------------------------------------------------------------ */

/** Fake port that throws on the first N invocations then yields one event
 *  on the (N+1)th. After yielding, completes normally. */
const makePort = (opts: {
  throwsBefore?: number
  thrown?: () => unknown
  yieldsOnSuccess?: number
  model?: string
  provider?: string
  authMode?: string
}): LLMPort => {
  let calls = 0
  const throwsBefore = opts.throwsBefore ?? 0
  const yieldsOnSuccess = opts.yieldsOnSuccess ?? 1
  const thrown = opts.thrown ?? (() => new Error("boom"))
  const port: LLMPort = {
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
    ...(opts.authMode !== undefined ? { authMode: opts.authMode } : {}),
    async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
      const n = calls++
      if (n < throwsBefore) {
        throw thrown()
      }
      for (let i = 0; i < yieldsOnSuccess; i++) {
        yield { type: "text_delta", delta: `chunk-${i}` } as StreamEvent
      }
    },
  }
  return port
}

/** Fake port that throws AFTER yielding one event (mid-stream throw). */
const makeMidStreamThrowPort = (thrown: () => unknown): LLMPort => ({
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: "first" } as StreamEvent
    throw thrown()
  },
})

const input: StreamInput = { messages: [], tools: [] } as unknown as StreamInput

/** Drain an async iterable to completion, returning events. */
const drain = async (port: LLMPort): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = []
  for await (const ev of port.stream(input)) {
    out.push(ev)
  }
  return out
}

/** Try-drain that returns the caught error or null. */
const tryDrain = async (port: LLMPort): Promise<unknown> => {
  try {
    await drain(port)
    return null
  } catch (e) {
    return e
  }
}

/* ------------------------------------------------------------------ */
/* A. default-OFF byte-identical                                       */
/* ------------------------------------------------------------------ */

describe("HELL-A: default-OFF byte-identical", () => {
  test("HELL-A1: knob absent → returns inner verbatim (identity port)", () => {
    const inner = makePort({})
    const { port } = withFailureCounter(inner, undefined)
    expect(port).toBe(inner)
  })

  test("HELL-A2: enabled:false → returns inner verbatim (identity port)", () => {
    const inner = makePort({})
    const { port } = withFailureCounter(inner, { enabled: false })
    expect(port).toBe(inner)
  })

  test("HELL-A3: identity handle reports 0 and reset is a no-op", () => {
    const inner = makePort({})
    const { handle } = withFailureCounter(inner, { enabled: false })
    expect(handle.getFailureCount()).toBe(0)
    handle.reset()
    expect(handle.getFailureCount()).toBe(0)
  })
})

/* ------------------------------------------------------------------ */
/* B. counter semantics                                                */
/* ------------------------------------------------------------------ */

describe("HELL-B: counter semantics (consecutive pre-stream failures)", () => {
  test("HELL-B4: N-1 failures → original error re-thrown, NOT too_many", async () => {
    // cap=3: failures 1 and 2 surface raw, only failure 3 is re-wrapped.
    const inner = makePort({ throwsBefore: 100, thrown: () => new Error("raw") })
    const { port } = withFailureCounter(inner, { enabled: true, maxConsecutiveFailures: 3 })
    const e1 = await tryDrain(port)
    const e2 = await tryDrain(port)
    expect(e1).toBeInstanceOf(Error)
    expect((e1 as Error).message).toBe("raw")
    expect(e1 instanceof LLMError && (e1 as LLMError).kind === "too_many_failed_attempts").toBe(
      false,
    )
    expect(e2).toBeInstanceOf(Error)
    expect(e2 instanceof LLMError && (e2 as LLMError).kind === "too_many_failed_attempts").toBe(
      false,
    )
  })

  test("HELL-B5: exactly N failures → Nth re-wrapped as too_many_failed_attempts", async () => {
    const inner = makePort({ throwsBefore: 100, thrown: () => new Error("raw") })
    const { port } = withFailureCounter(inner, { enabled: true, maxConsecutiveFailures: 3 })
    await tryDrain(port)
    await tryDrain(port)
    const e3 = await tryDrain(port)
    expect(e3).toBeInstanceOf(LLMError)
    expect((e3 as LLMError).kind).toBe("too_many_failed_attempts")
    expect((e3 as LLMError).message).toContain("3/3")
    expect((e3 as LLMError).message).toContain("raw")
  })

  test("HELL-B6: N+1 (and beyond) failures → still re-wrapped (idempotent at cap)", async () => {
    const inner = makePort({ throwsBefore: 100, thrown: () => new Error("raw") })
    const { port } = withFailureCounter(inner, { enabled: true, maxConsecutiveFailures: 2 })
    await tryDrain(port) // count=1, raw
    const e2 = await tryDrain(port) // count=2 ⇒ wrap
    const e3 = await tryDrain(port) // count=3, still ≥ cap ⇒ wrap
    const e4 = await tryDrain(port) // count=4, still ≥ cap ⇒ wrap
    expect((e2 as LLMError).kind).toBe("too_many_failed_attempts")
    expect((e3 as LLMError).kind).toBe("too_many_failed_attempts")
    expect((e4 as LLMError).kind).toBe("too_many_failed_attempts")
  })

  test("HELL-B7: one successful iteration RESETS the counter to 0", async () => {
    // First N-1 throws, then 1 success, then N-1 throws again ⇒ NOT wrapped.
    let callIndex = 0
    const inner: LLMPort = {
      async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
        const n = callIndex++
        // 0,1: throw   2: succeed   3,4: throw
        if (n === 0 || n === 1 || n === 3 || n === 4) throw new Error(`raw-${n}`)
        yield { type: "text_delta", delta: "ok" } as StreamEvent
      },
    }
    const { port, handle } = withFailureCounter(inner, {
      enabled: true,
      maxConsecutiveFailures: 3,
    })
    await tryDrain(port)
    await tryDrain(port)
    expect(handle.getFailureCount()).toBe(2)
    // success → reset.
    await drain(port)
    expect(handle.getFailureCount()).toBe(0)
    // Next two throws — count returns to 2, still < 3, NOT wrapped.
    const e3 = await tryDrain(port)
    const e4 = await tryDrain(port)
    expect(e3 instanceof LLMError && (e3 as LLMError).kind === "too_many_failed_attempts").toBe(
      false,
    )
    expect(e4 instanceof LLMError && (e4 as LLMError).kind === "too_many_failed_attempts").toBe(
      false,
    )
    expect(handle.getFailureCount()).toBe(2)
  })

  test("HELL-B8: handle.reset() drops the counter", async () => {
    const inner = makePort({ throwsBefore: 100, thrown: () => new Error("raw") })
    const { port, handle } = withFailureCounter(inner, {
      enabled: true,
      maxConsecutiveFailures: 3,
    })
    await tryDrain(port)
    await tryDrain(port)
    expect(handle.getFailureCount()).toBe(2)
    handle.reset()
    expect(handle.getFailureCount()).toBe(0)
    // Next throw → count=1 only, NOT wrapped (cap=3).
    const e = await tryDrain(port)
    expect(e instanceof LLMError && (e as LLMError).kind === "too_many_failed_attempts").toBe(false)
  })

  test("HELL-B9: handle.getFailureCount() reflects each throw", async () => {
    const inner = makePort({ throwsBefore: 100, thrown: () => new Error("raw") })
    const { port, handle } = withFailureCounter(inner, {
      enabled: true,
      maxConsecutiveFailures: 10,
    })
    expect(handle.getFailureCount()).toBe(0)
    await tryDrain(port)
    expect(handle.getFailureCount()).toBe(1)
    await tryDrain(port)
    expect(handle.getFailureCount()).toBe(2)
  })
})

/* ------------------------------------------------------------------ */
/* C. mid-stream throws DO NOT increment counter                       */
/* ------------------------------------------------------------------ */

describe("HELL-C: mid-stream throws do NOT count toward the budget", () => {
  test("HELL-C10: mid-stream throw passes through unchanged (counter not ticked)", async () => {
    const inner = makeMidStreamThrowPort(() => new Error("mid"))
    const { port, handle } = withFailureCounter(inner, {
      enabled: true,
      maxConsecutiveFailures: 1,
    })
    // Mid-stream: even with cap=1, the throw passes through raw.
    const e = await tryDrain(port)
    expect(e).toBeInstanceOf(Error)
    expect((e as Error).message).toBe("mid")
    expect(e instanceof LLMError && (e as LLMError).kind === "too_many_failed_attempts").toBe(false)
    expect(handle.getFailureCount()).toBe(0)
  })

  test("HELL-C11: pre-stream throws AFTER a mid-stream throw still count from 0", async () => {
    // Mix: mid-stream throw (no count), then 2 pre-stream throws.
    let callIndex = 0
    const inner: LLMPort = {
      async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
        const n = callIndex++
        if (n === 0) {
          yield { type: "text_delta", delta: "first" } as StreamEvent
          throw new Error("mid")
        }
        throw new Error(`pre-${n}`)
      },
    }
    const { port, handle } = withFailureCounter(inner, {
      enabled: true,
      maxConsecutiveFailures: 2,
    })
    await tryDrain(port) // mid-stream: counter stays 0
    expect(handle.getFailureCount()).toBe(0)
    await tryDrain(port) // pre-stream: count=1
    expect(handle.getFailureCount()).toBe(1)
    const e2 = await tryDrain(port) // pre-stream: count=2 ⇒ wrap
    expect((e2 as LLMError).kind).toBe("too_many_failed_attempts")
  })
})

/* ------------------------------------------------------------------ */
/* D. wrap preserves provider / statusCode / cause                     */
/* ------------------------------------------------------------------ */

describe("HELL-D: wrap shape preserves provider / status / cause", () => {
  test("HELL-D12: cause preserves the original error reference", async () => {
    const original = new Error("original")
    const inner = makePort({ throwsBefore: 100, thrown: () => original })
    const { port } = withFailureCounter(inner, { enabled: true, maxConsecutiveFailures: 1 })
    const e = await tryDrain(port)
    expect(e).toBeInstanceOf(LLMError)
    expect((e as LLMError).cause).toBe(original)
  })

  test("HELL-D13: provider + statusCode + providerCode forward from inner LLMError", async () => {
    const inner = makePort({
      throwsBefore: 100,
      thrown: () =>
        new LLMError("upstream", {
          kind: "server_error",
          provider: "anthropic",
          statusCode: 503,
          providerCode: "service_unavailable",
        }),
    })
    const { port } = withFailureCounter(inner, { enabled: true, maxConsecutiveFailures: 1 })
    const e = await tryDrain(port)
    expect(e).toBeInstanceOf(LLMError)
    const llm = e as LLMError
    expect(llm.kind).toBe("too_many_failed_attempts")
    expect(llm.provider).toBe("anthropic")
    expect(llm.statusCode).toBe(503)
    expect(llm.providerCode).toBe("service_unavailable")
  })

  test("HELL-D14: model / provider / authMode forward onto the decorated port", () => {
    const inner = makePort({
      model: "test-model-x",
      provider: "openai",
      authMode: "BYOK",
    })
    const { port } = withFailureCounter(inner, { enabled: true })
    expect(port.model).toBe("test-model-x")
    expect(port.provider).toBe("openai")
    expect(port.authMode).toBe("BYOK")
  })
})

/* ------------------------------------------------------------------ */
/* E. knob clamps + edge cases                                          */
/* ------------------------------------------------------------------ */

describe("HELL-E: knob clamps + edge cases", () => {
  test("HELL-E15: DEFAULT_MAX_CONSECUTIVE_FAILURES is 5 (hellgate pin)", () => {
    expect(DEFAULT_MAX_CONSECUTIVE_FAILURES).toBe(5)
  })

  test("HELL-E16: maxConsecutiveFailures omitted → uses DEFAULT (5)", async () => {
    const inner = makePort({ throwsBefore: 100, thrown: () => new Error("raw") })
    const { port } = withFailureCounter(inner, { enabled: true })
    // First 4 throws are NOT wrapped.
    for (let i = 0; i < 4; i++) {
      const e = await tryDrain(port)
      expect(e instanceof LLMError && (e as LLMError).kind === "too_many_failed_attempts").toBe(
        false,
      )
    }
    // 5th throw IS wrapped.
    const e5 = await tryDrain(port)
    expect((e5 as LLMError).kind).toBe("too_many_failed_attempts")
  })

  test("HELL-E17: clampCap honors edge values (0 / -1 / NaN / Infinity / float)", () => {
    expect(__test.clampCap(undefined)).toBe(DEFAULT_MAX_CONSECUTIVE_FAILURES)
    expect(__test.clampCap(0)).toBe(1) // clamped UP to min 1
    expect(__test.clampCap(-5)).toBe(1) // clamped UP to min 1
    expect(__test.clampCap(Number.NaN)).toBe(DEFAULT_MAX_CONSECUTIVE_FAILURES)
    expect(__test.clampCap(Number.POSITIVE_INFINITY)).toBe(DEFAULT_MAX_CONSECUTIVE_FAILURES)
    expect(__test.clampCap(Number.NEGATIVE_INFINITY)).toBe(DEFAULT_MAX_CONSECUTIVE_FAILURES)
    expect(__test.clampCap(2.7)).toBe(2) // floor
    expect(__test.clampCap(3)).toBe(3) // identity
    expect(__test.clampCap(1)).toBe(1) // identity at min
  })

  test("HELL-E18: cap=1 wraps the very first failure (smoke for the lowest legal cap)", async () => {
    const inner = makePort({ throwsBefore: 100, thrown: () => new Error("raw") })
    const { port } = withFailureCounter(inner, { enabled: true, maxConsecutiveFailures: 1 })
    const e = await tryDrain(port)
    expect((e as LLMError).kind).toBe("too_many_failed_attempts")
    expect((e as LLMError).message).toContain("1/1")
  })
})
