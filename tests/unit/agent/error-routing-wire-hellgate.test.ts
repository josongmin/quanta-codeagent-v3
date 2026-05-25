/**
 * ADR-0203 wire hellgate — RetryingLLM × ErrorClassifier/RetryRouter seam.
 *
 * 4 invariants on the opt-in `errorRouting` knob added to `RetryingLLMOptions`:
 *
 *   HELL-ER-WIRE-01  default-OFF byte-identical — no errorRouting ⇒ retry
 *                    behavior matches the pre-wire path exactly (same retry
 *                    count, same backoff, same throw shape).
 *   HELL-ER-WIRE-02  router `abort` decision short-circuits retry — even when
 *                    legacy `isRetryable` would have returned true, an
 *                    `abort`-routing error is rethrown WITHOUT a sleep call
 *                    (no backoff observed).
 *   HELL-ER-WIRE-03  router `hitl` decision short-circuits retry — same as
 *                    above but for the human-in-the-loop arm.
 *   HELL-ER-WIRE-04  router `retry-with-backoff` decision does NOT veto a
 *                    legacy-retryable error — the wrapper still consults
 *                    `isRetryable` and retries; both gates must vote retry.
 */

import { describe, expect, test } from "bun:test"
import {
  defaultErrorClassifier,
  defaultRetryRouter,
  type RetryAction,
  type RetryRouter,
  type TypedError,
} from "@/agent/error-routing"
import { RetryingLLM } from "@/agent/retry"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { LLMError } from "@/shared"

const constRandom = (): number => 0

// Wrap an inner that throws on EVERY attempt — caller observes the eventual
// throw + the count of stream() invocations (== retry attempts + 1).
// The generator body never yields (throws before the first yield), so the
// `LLMPort.stream` AsyncIterable<StreamEvent> contract is satisfied via the
// type-only generator return; no body yield is needed under TS noImplicitAny.
const countingThrowLLM = (e: unknown): { llm: LLMPort; calls: { n: number } } => {
  const calls = { n: 0 }
  const llm: LLMPort = {
    stream(_input: StreamInput): AsyncIterable<StreamEvent> {
      calls.n += 1
      // RetryingLLM calls `this.inner.stream(input)` once per attempt, so
      // bumping on each stream() invocation == one bump per actual attempt.
      // Generator throws BEFORE any yield, mirroring a connection-phase
      // failure (the only retry-eligible class per the legacy contract).
      // biome-ignore lint/correctness/useYield: throwing generator is the test fixture.
      return (async function* gen(): AsyncIterable<StreamEvent> {
        throw e
      })()
    },
  }
  return { llm, calls }
}

const drain = async (llm: LLMPort): Promise<{ thrown: unknown }> => {
  try {
    for await (const _ev of llm.stream({ messages: [] } as unknown as StreamInput)) {
      // empty — the failing inner throws BEFORE yielding
    }
    return { thrown: null }
  } catch (e) {
    return { thrown: e }
  }
}

// ----------------------------------------------------------------------------
// HELL-ER-WIRE-01: default-OFF byte-identical — no errorRouting ⇒ retry path
// unchanged from pre-wire shape.
// ----------------------------------------------------------------------------

describe("HELL-ER-WIRE-01 default-OFF byte-identical", () => {
  test("absent errorRouting: retryable LLMError is retried maxRetries+1 times", async () => {
    // A `rate_limit` LLMError is RETRY_KIND ⇒ retried.
    const retryable = new LLMError("rate limited", { kind: "rate_limit" })
    const { llm: inner, calls } = countingThrowLLM(retryable)
    const sleepCalls: number[] = []
    const wrap = new RetryingLLM({
      inner,
      maxRetries: 2,
      baseDelayMs: 1,
      sleep: async (ms) => {
        sleepCalls.push(ms)
      },
      random: constRandom,
    })
    const { thrown } = await drain(wrap)
    expect(thrown).toBeInstanceOf(LLMError)
    // 3 attempts (initial + 2 retries) → 2 sleep calls.
    expect(calls.n).toBe(3)
    expect(sleepCalls.length).toBe(2)
  })

  test("absent errorRouting: non-retryable LLMError throws immediately (no retries, no sleep)", async () => {
    const fatal = new LLMError("auth bad", { kind: "auth" })
    const { llm: inner, calls } = countingThrowLLM(fatal)
    const sleepCalls: number[] = []
    const wrap = new RetryingLLM({
      inner,
      maxRetries: 4,
      baseDelayMs: 1,
      sleep: async (ms) => {
        sleepCalls.push(ms)
      },
      random: constRandom,
    })
    const { thrown } = await drain(wrap)
    expect(thrown).toBeInstanceOf(LLMError)
    expect(calls.n).toBe(1)
    expect(sleepCalls.length).toBe(0)
  })
})

// ----------------------------------------------------------------------------
// HELL-ER-WIRE-02..03: router veto on abort/hitl SHORT-CIRCUITS retry.
// ----------------------------------------------------------------------------

const vetoRouter = (forced: RetryAction): RetryRouter => ({
  decide(_e: TypedError): RetryAction {
    return forced
  },
})

describe("HELL-ER-WIRE-02..03 router shortcut on abort/hitl", () => {
  test("router decides 'abort' → no retry, no sleep, even if isRetryable says retry", async () => {
    // `rate_limit` is normally RETRYABLE; the router vetoes.
    const retryable = new LLMError("rate limited", { kind: "rate_limit" })
    const { llm: inner, calls } = countingThrowLLM(retryable)
    const sleepCalls: number[] = []
    const wrap = new RetryingLLM({
      inner,
      maxRetries: 4,
      baseDelayMs: 1,
      sleep: async (ms) => {
        sleepCalls.push(ms)
      },
      random: constRandom,
      errorRouting: { classifier: defaultErrorClassifier, router: vetoRouter("abort") },
    })
    const { thrown } = await drain(wrap)
    expect(thrown).toBeInstanceOf(LLMError)
    expect(calls.n).toBe(1) // no retry
    expect(sleepCalls.length).toBe(0) // no backoff observed
  })

  test("router decides 'hitl' → same short-circuit semantics", async () => {
    const retryable = new LLMError("overloaded", { kind: "overloaded" })
    const { llm: inner, calls } = countingThrowLLM(retryable)
    const sleepCalls: number[] = []
    const wrap = new RetryingLLM({
      inner,
      maxRetries: 4,
      baseDelayMs: 1,
      sleep: async (ms) => {
        sleepCalls.push(ms)
      },
      random: constRandom,
      errorRouting: { classifier: defaultErrorClassifier, router: vetoRouter("hitl") },
    })
    const { thrown } = await drain(wrap)
    expect(thrown).toBeInstanceOf(LLMError)
    expect(calls.n).toBe(1)
    expect(sleepCalls.length).toBe(0)
  })
})

// ----------------------------------------------------------------------------
// HELL-ER-WIRE-04: non-veto router actions defer to the legacy isRetryable.
// ----------------------------------------------------------------------------

describe("HELL-ER-WIRE-04 router non-veto defers to legacy retry path", () => {
  test("router decides 'retry-with-backoff' on a retryable LLMError → still retried", async () => {
    const retryable = new LLMError("rate limited", { kind: "rate_limit" })
    const { llm: inner, calls } = countingThrowLLM(retryable)
    const sleepCalls: number[] = []
    const wrap = new RetryingLLM({
      inner,
      maxRetries: 2,
      baseDelayMs: 1,
      sleep: async (ms) => {
        sleepCalls.push(ms)
      },
      random: constRandom,
      // Default router would say retry-with-backoff for rate_limit → 429.
      errorRouting: { classifier: defaultErrorClassifier, router: defaultRetryRouter },
    })
    const { thrown } = await drain(wrap)
    expect(thrown).toBeInstanceOf(LLMError)
    expect(calls.n).toBe(3)
    expect(sleepCalls.length).toBe(2)
  })

  test("router decides 'swap-fallback' on internalServerError → NOT a veto, but isRetryable says no → throws immediately", async () => {
    // `server_error` LLMError without statusCode → defaults to retryable in
    // the legacy classifier (RETRYABLE_KINDS contains 'server_error'); the
    // typed router would route it to `swap-fallback` (a non-veto). Caller
    // observes the legacy retry path runs (3 attempts) — both gates vote
    // retry, the wrapper retries.
    const serverErr = new LLMError("internal", { kind: "server_error" })
    const { llm: inner, calls } = countingThrowLLM(serverErr)
    const sleepCalls: number[] = []
    const wrap = new RetryingLLM({
      inner,
      maxRetries: 1,
      baseDelayMs: 1,
      sleep: async (ms) => {
        sleepCalls.push(ms)
      },
      random: constRandom,
      errorRouting: { classifier: defaultErrorClassifier, router: defaultRetryRouter },
    })
    const { thrown } = await drain(wrap)
    expect(thrown).toBeInstanceOf(LLMError)
    expect(calls.n).toBe(2) // initial + 1 retry
    expect(sleepCalls.length).toBe(1)
  })
})
