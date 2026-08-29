/**
 * Hellgate — `withRetryPRetry` (p-retry@8-backed adapter, ADR-0192).
 *
 * Sibling to `RetryingLLM` (`src/agent/retry.ts`). The streaming class is
 * INTENTIONALLY untouched — see ADR-0192 negative invariants. This battery
 * proves the PROMISE-shaped helper:
 *
 *   A. happy path                  (1)  — first-try success
 *   B. retry-then-succeed          (3)  — attempts count / exp growth / jitter
 *   C. exhaustion                  (2)  — attempts === max / last error kept
 *   D. classification              (3)  — non-retryable short-circuit / mark
 *                                          override / onAttempt firing
 *   E. AbortSignal                 (3)  — pre-abort / mid-wait abort / forward
 *
 * Total: 12 cases. Bun's `bun:test`. Deterministic: each `fn` is a closure
 * over a counter; timing tests use `minTimeout:1, maxTimeout:32` so the full
 * battery finishes in <100ms.
 */

import { describe, expect, test } from "bun:test"
import { withRetryPRetry } from "@/agent/retry-pretry"
import { LLMError } from "@/shared"

/** Build an LLMError whose `.kind` makes it retryable per `isRetryable`. */
const transient = (msg = "overloaded"): LLMError => new LLMError(msg, { kind: "overloaded" })

/** Build an LLMError whose `.kind` makes it fatal per `isRetryable`. */
const fatal = (msg = "invalid api key"): LLMError => new LLMError(msg, { kind: "auth" })

describe("withRetryPRetry — A. happy path", () => {
  test("1. fn resolves first call → kind:ok, attempts=1, value preserved", async () => {
    let calls = 0
    const r = await withRetryPRetry(async () => {
      calls++
      return 42
    })
    expect(r.kind).toBe("ok")
    if (r.kind === "ok") {
      expect(r.value).toBe(42)
      expect(r.attempts).toBe(1)
    }
    expect(calls).toBe(1)
  })
})

describe("withRetryPRetry — B. retry then succeed", () => {
  test("2. fails 2x with retryable, then succeeds → kind:ok, attempts=3", async () => {
    let calls = 0
    const r = await withRetryPRetry(
      async () => {
        calls++
        if (calls < 3) throw transient(`overloaded n=${calls}`)
        return "win"
      },
      { initialDelayMs: 1, maxDelayMs: 4, jitter: false },
    )
    expect(r.kind).toBe("ok")
    if (r.kind === "ok") {
      expect(r.value).toBe("win")
      expect(r.attempts).toBe(3)
    }
    expect(calls).toBe(3)
  })

  test("3. exponential growth: delays observed via onAttempt are non-decreasing", async () => {
    const stamps: number[] = []
    let calls = 0
    const r = await withRetryPRetry(
      async () => {
        stamps.push(performance.now())
        calls++
        if (calls < 4) throw transient()
        return "ok"
      },
      {
        initialDelayMs: 8,
        maxDelayMs: 64,
        jitter: false, // deterministic so we can assert ordering
        factor: 2,
      },
    )
    expect(r.kind).toBe("ok")
    expect(stamps.length).toBe(4)
    const [s0, s1, s2, s3] = stamps as [number, number, number, number]
    const d1 = s1 - s0
    const d2 = s2 - s1
    const d3 = s3 - s2
    // With factor=2, jitter off, minTimeout=8, maxTimeout=64 the SCHEDULE is
    // 8 / 16 / 32. Each observed gap is asserted against its own floor, not
    // against its neighbour.
    //
    // Monotonicity was the wrong invariant: a loaded scheduler stretches one
    // sleep and not the next, so `d2 >= d1` breaks while the backoff is
    // perfectly correct — measured, it failed in two of eight suite shards and
    // passed in isolation every time. A floor cannot break that way, because
    // load only ever ADDS: `setTimeout(8)` can take 60ms, never 3ms.
    //
    // It still catches the thing the test is for. A backoff stuck at its
    // initial delay leaves d3 near 8, far under 32.
    const EARLY_MS = 2 // timers may fire marginally early
    expect(d1).toBeGreaterThanOrEqual(8 - EARLY_MS)
    expect(d2).toBeGreaterThanOrEqual(16 - EARLY_MS)
    expect(d3).toBeGreaterThanOrEqual(32 - EARLY_MS)
  })

  test("4. jitter on → delays vary across runs (not byte-identical)", async () => {
    const runOnce = async (): Promise<number[]> => {
      const stamps: number[] = []
      let calls = 0
      await withRetryPRetry(
        async () => {
          stamps.push(performance.now())
          calls++
          if (calls < 4) throw transient()
        },
        { initialDelayMs: 8, maxDelayMs: 32, jitter: true, factor: 2 },
      )
      const [s0, s1, s2] = stamps as [number, number, number]
      return [s1 - s0, s2 - s1]
    }
    // Run twice; with jitter on the (d1,d2) pair should differ at least
    // somewhere across two independent runs. Loop up to 5 times to defeat
    // the (vanishingly small) chance of identical jitter samples.
    let differed = false
    for (let i = 0; i < 5 && !differed; i++) {
      const [a, b] = await Promise.all([runOnce(), runOnce()])
      if (a[0] !== b[0] || a[1] !== b[1]) differed = true
    }
    expect(differed).toBe(true)
  })
})

describe("withRetryPRetry — C. exhaustion", () => {
  test("5. fn always fails retryable → attempts === maxAttempts, kind:failed", async () => {
    let calls = 0
    const r = await withRetryPRetry(
      async () => {
        calls++
        throw transient(`overloaded n=${calls}`)
      },
      { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 4, jitter: false },
    )
    expect(r.kind).toBe("failed")
    if (r.kind === "failed") {
      expect(r.attempts).toBe(3)
      expect(r.error.message).toContain("overloaded n=3")
    }
    expect(calls).toBe(3)
  })

  test("6. last error preserved on result.error (not the first)", async () => {
    let calls = 0
    const r = await withRetryPRetry(
      async () => {
        calls++
        throw transient(`call-${calls}`)
      },
      { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 2, jitter: false },
    )
    expect(r.kind).toBe("failed")
    if (r.kind === "failed") {
      expect(r.error.message).toBe("call-2")
    }
  })
})

describe("withRetryPRetry — D. classification", () => {
  test("7. non-retryable LLMError (auth) → no retry, attempts=1", async () => {
    let calls = 0
    const r = await withRetryPRetry(
      async () => {
        calls++
        throw fatal()
      },
      { maxAttempts: 5, initialDelayMs: 1, maxDelayMs: 2 },
    )
    expect(r.kind).toBe("failed")
    if (r.kind === "failed") {
      expect(r.attempts).toBe(1)
      expect(r.error).toBeInstanceOf(LLMError)
      expect(r.error.message).toBe("invalid api key")
    }
    expect(calls).toBe(1)
  })

  test("8. custom retryableMarkers override → retries on its yes, stops on its no", async () => {
    let calls = 0
    const r = await withRetryPRetry(
      async () => {
        calls++
        if (calls < 3) throw new Error("yes-please-retry")
        return "done"
      },
      {
        maxAttempts: 5,
        initialDelayMs: 1,
        maxDelayMs: 2,
        jitter: false,
        retryableMarkers: (e) => e instanceof Error && e.message.includes("yes-please-retry"),
      },
    )
    expect(r.kind).toBe("ok")
    if (r.kind === "ok") expect(r.attempts).toBe(3)
  })

  test("9. onAttempt fires once per failed attempt (NOT on success)", async () => {
    const seen: Array<{ attempt: number; retriesLeft: number }> = []
    let calls = 0
    const r = await withRetryPRetry(
      async () => {
        calls++
        if (calls < 3) throw transient()
        return "ok"
      },
      {
        maxAttempts: 5,
        initialDelayMs: 1,
        maxDelayMs: 2,
        jitter: false,
        onAttempt: (info) => seen.push({ attempt: info.attempt, retriesLeft: info.retriesLeft }),
      },
    )
    expect(r.kind).toBe("ok")
    // 2 failures → 2 callbacks; success attempt #3 does NOT fire onAttempt.
    expect(seen.length).toBe(2)
    const [e0, e1] = seen as [(typeof seen)[number], (typeof seen)[number]]
    expect(e0.attempt).toBe(1)
    expect(e1.attempt).toBe(2)
    // retriesLeft must be strictly decreasing.
    expect(e0.retriesLeft).toBeGreaterThan(e1.retriesLeft)
  })
})

describe("withRetryPRetry — E. AbortSignal", () => {
  test("10. signal pre-aborted → kind:failed, attempts=0, fn never called", async () => {
    const ac = new AbortController()
    ac.abort(new Error("user-cancel"))
    let calls = 0
    const r = await withRetryPRetry(
      async () => {
        calls++
        return 1
      },
      { signal: ac.signal, maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 2 },
    )
    expect(r.kind).toBe("failed")
    if (r.kind === "failed") {
      expect(r.attempts).toBe(0)
      expect(r.error.message).toBe("user-cancel")
    }
    expect(calls).toBe(0)
  })

  test("11. signal aborted between attempts → halts further retries", async () => {
    const ac = new AbortController()
    let calls = 0
    const r = await withRetryPRetry(
      async () => {
        calls++
        // Abort AFTER the second failure so the sleep before attempt 3 is
        // the one that gets cancelled by p-retry.
        if (calls === 2) {
          queueMicrotask(() => ac.abort(new Error("mid-flight")))
        }
        throw transient(`call-${calls}`)
      },
      {
        signal: ac.signal,
        maxAttempts: 10,
        initialDelayMs: 20,
        maxDelayMs: 40,
        jitter: false,
      },
    )
    expect(r.kind).toBe("failed")
    // Without abort we would have hit 10 attempts; the abort must stop us
    // well short of that.
    expect(calls).toBeLessThan(10)
    expect(calls).toBeGreaterThanOrEqual(2)
  })

  test("12. signal forwarded so a signal-aware fn observes it", async () => {
    const ac = new AbortController()
    let observedAborted = false
    // Wrap so fn closes over `ac.signal` (the same signal we pass to
    // withRetryPRetry); a signal-aware fn would consult it.
    const r = await withRetryPRetry(
      async () => {
        // Trip abort on the first call so subsequent reads observe it.
        if (!ac.signal.aborted) ac.abort(new Error("forward-test"))
        observedAborted = ac.signal.aborted
        throw transient("call")
      },
      {
        signal: ac.signal,
        maxAttempts: 5,
        initialDelayMs: 10,
        maxDelayMs: 20,
        jitter: false,
      },
    )
    expect(observedAborted).toBe(true)
    expect(r.kind).toBe("failed")
  })
})
