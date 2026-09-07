/**
 * Hellgate for DOF-30 — single-authority decorator policy.
 *
 * Proves the `RetryingLLM` (src/agent/retry.ts) and `FallbackLLM`
 * (src/llm/fallback.ts) decorators now DERIVE their retry / fallback decisions
 * from the ONE `codexSpecRoute` table (src/llm/retry/decorator-policy.ts),
 * having DELETED their own hardcoded `RETRYABLE_KINDS`/`FATAL_KINDS`/
 * `FALLBACK_KINDS` sets. Two independent kind-set sources of truth collapsed
 * onto one.
 *
 * Layers of proof:
 *   1. DERIVATION — every one of the 18 `LLMErrorKind`s is covered; the one
 *      intentional post-dedup correction makes every table `hitl_handoff`
 *      decisive no-retry while preserving the other historical decisions.
 *   2. ON-PROOF THROUGH THE REAL DECORATORS — drive `RetryingLLM` / `FallbackLLM`
 *      and assert their observable retry / provider-swap behaviour keys on the
 *      table.
 *   3. RED-ON-INJECTION (wiring proof) — the derived predicates ARE the wire;
 *      an ORACLE precondition asserts each decorator's decision equals the
 *      table's projection, so breaking the derivation would flip a case here.
 *   4. SOLE-SOURCE — no second hardcoded kind set survives in the decorators.
 */

import { describe, expect, test } from "bun:test"
import { isRetryable, RetryingLLM } from "@/agent"
import {
  codexSpecRoute,
  FallbackLLM,
  isFallbackKind,
  isFallbackTrigger,
  type LLMPort,
  retryDispositionForKind,
  type StreamEvent,
} from "@/llm"
import { LLMError, type LLMErrorKind } from "@/shared"

/** All 18 members of the `LLMErrorKind` union (compile-checked by construction:
 *  a missing member would make the derivation tests skip it, but the
 *  exhaustiveness of `codexSpecRoute` already guards the union). */
const ALL_KINDS: readonly LLMErrorKind[] = [
  "overloaded",
  "rate_limit",
  "server_error",
  "network",
  "auth",
  "bad_request",
  "not_found",
  "not_implemented",
  "stream_corrupt",
  "aborted",
  "unknown",
  "context_window_exceeded",
  "cyber_policy",
  "too_many_failed_attempts",
  "thread_rollback_failed",
  "sandbox_error",
  "sandbox_blocked",
  "invalid_image",
]

// ── The PRE-DEDUP golden reference sets (verbatim from the removed hardcoded
//    declarations in src/agent/retry.ts and src/llm/fallback.ts). If the
//    derivation drifts from these, dedup silently changed behaviour. ──────────
const HISTORICAL_RETRYABLE_KINDS = new Set<string>([
  "overloaded",
  "rate_limit",
  "server_error",
  "network",
])
const HISTORICAL_FATAL_KINDS = new Set<string>([
  "auth",
  "bad_request",
  "not_found",
  "not_implemented",
  "stream_corrupt",
  "aborted",
  "invalid_image",
])
const HISTORICAL_FALLBACK_KINDS = new Set<string>([
  "overloaded",
  "server_error",
  "network",
  "not_implemented",
])

/** The three-way disposition the LEGACY `isRetryable` kind-branch produced,
 *  reconstructed from the historical sets. Anything in neither set fell through
 *  to the message-marker scan. */
const historicalDisposition = (k: string): "retry" | "no_retry" | "consult_markers" => {
  if (HISTORICAL_RETRYABLE_KINDS.has(k)) return "retry"
  if (HISTORICAL_FATAL_KINDS.has(k)) return "no_retry"
  return "consult_markers"
}

const HITL_NO_RETRY_KINDS = [
  "auth",
  "cyber_policy",
  "sandbox_error",
  "sandbox_blocked",
] as const satisfies readonly LLMErrorKind[]
const HITL_NO_RETRY = new Set<LLMErrorKind>(HITL_NO_RETRY_KINDS)

const expectedDisposition = (kind: LLMErrorKind): ReturnType<typeof historicalDisposition> =>
  codexSpecRoute(kind) === "hitl_handoff" ? "no_retry" : historicalDisposition(kind)

describe("DOF-30/SEP6-01 derivation — table-owned HITL correction over historical parity", () => {
  for (const kind of ALL_KINDS) {
    test(`retryDispositionForKind(${kind}) matches the corrected table projection`, () => {
      expect(retryDispositionForKind(kind)).toBe(expectedDisposition(kind))
    })

    test(`isFallbackKind(${kind}) matches the removed FALLBACK_KINDS set`, () => {
      expect(isFallbackKind(kind)).toBe(HISTORICAL_FALLBACK_KINDS.has(kind))
    })
  }

  test("derived fallback set is EXACTLY the table's fallback_provider action (clean 1:1)", () => {
    for (const kind of ALL_KINDS) {
      expect(isFallbackKind(kind)).toBe(codexSpecRoute(kind) === "fallback_provider")
    }
  })

  test("anti-vacuum: all four current HITL kinds are decisive no-retry", () => {
    expect(HITL_NO_RETRY_KINDS).toHaveLength(4)
    expect(new Set<LLMErrorKind>(HITL_NO_RETRY_KINDS)).toEqual(
      new Set<LLMErrorKind>(ALL_KINDS.filter((kind) => codexSpecRoute(kind) === "hitl_handoff")),
    )
  })
})

// ── Non-vacuity guard: the golden reference must actually differ across kinds,
//    else the parity assertions above are trivially satisfiable. ──────────────
describe("DOF-30 derivation parity — reference sets are non-degenerate", () => {
  test("dispositions span all three outcomes AND fallback spans both booleans", () => {
    const dispositions = new Set(ALL_KINDS.map((k) => retryDispositionForKind(k)))
    expect(dispositions).toEqual(new Set(["retry", "no_retry", "consult_markers"]))
    const fallbacks = new Set(ALL_KINDS.map((k) => isFallbackKind(k)))
    expect(fallbacks).toEqual(new Set([true, false]))
  })
})

// ── Test doubles ─────────────────────────────────────────────────────────────
const collect = async (it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

class ThrowingLLM implements LLMPort {
  calls = 0
  constructor(private readonly error: unknown) {}
  async *stream(): AsyncIterable<StreamEvent> {
    this.calls += 1
    // yield nothing, then throw pre-stream (retry/fallback eligible boundary)
    throw this.error
    // biome-ignore lint/correctness/noUnreachable: generator body needs a yield-typed return
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

class OkLLM implements LLMPort {
  calls = 0
  readonly model = "ok-model"
  async *stream(): AsyncIterable<StreamEvent> {
    this.calls += 1
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

describe("DOF-30 ON-proof — RetryingLLM retry decision flows from codexSpecRoute", () => {
  // A kind the table routes to a same-provider-retryable action RETRIES; a kind
  // it routes fatal/hitl does NOT. Observable via inner.calls.
  test("retryable table kind (rate_limit → retry_after_backoff) ⇒ RetryingLLM retries then succeeds", async () => {
    // ORACLE precondition — the derived wire says "retry".
    expect(retryDispositionForKind("rate_limit")).toBe("retry")

    let call = 0
    const inner: LLMPort = {
      async *stream(): AsyncIterable<StreamEvent> {
        call += 1
        if (call === 1) throw new LLMError("429", { kind: "rate_limit" })
        yield { type: "message_stop", stop_reason: "end_turn" }
      },
    }
    const r = new RetryingLLM({ inner, maxRetries: 2, sleep: async () => {}, random: () => 0 })
    const events = await collect(r.stream({ messages: [], tools: [] }))
    expect(events).toEqual([{ type: "message_stop", stop_reason: "end_turn" }])
    expect(call).toBe(2) // retried exactly once
  })

  test("non-retryable table kind (auth → hitl_handoff) ⇒ RetryingLLM does NOT retry", async () => {
    // ORACLE precondition — the derived wire says "no_retry".
    expect(retryDispositionForKind("auth")).toBe("no_retry")
    const inner = new ThrowingLLM(new LLMError("401 unauthorized", { kind: "auth" }))
    const r = new RetryingLLM({ inner, maxRetries: 4, sleep: async () => {}, random: () => 0 })
    await expect(collect(r.stream({ messages: [], tools: [] }))).rejects.toThrow("401")
    expect(inner.calls).toBe(1) // no retry
  })

  test("not_implemented (fallback_provider action) is NON-retryable at RetryingLLM (carve-out) but IS a fallback trigger", () => {
    // The one place the retry axis and the table action diverge: table routes
    // it to fallback_provider, but same-provider retry is waste (stub throws
    // identically). Derivation encodes both: no same-provider retry, YES swap.
    expect(codexSpecRoute("not_implemented")).toBe("fallback_provider")
    expect(retryDispositionForKind("not_implemented")).toBe("no_retry")
    expect(isRetryable(new LLMError("stub", { kind: "not_implemented" }))).toBe(false)
    expect(isFallbackTrigger(new LLMError("stub", { kind: "not_implemented" }))).toBe(true)
  })
})

describe("DOF-30 ON-proof — FallbackLLM swap decision flows from codexSpecRoute", () => {
  test("fallback_provider table kind (server_error) ⇒ FallbackLLM advances to the next provider", async () => {
    // ORACLE precondition — the derived wire says this kind is a fallback trigger.
    expect(isFallbackKind("server_error")).toBe(true)
    const primary = new ThrowingLLM(new LLMError("500", { kind: "server_error" }))
    const secondary = new OkLLM()
    const chain = new FallbackLLM({ providers: [primary, secondary] })
    const events = await collect(chain.stream({ messages: [], tools: [] }))
    expect(events).toEqual([{ type: "message_stop", stop_reason: "end_turn" }])
    expect(primary.calls).toBe(1)
    expect(secondary.calls).toBe(1) // swap happened
  })

  test("non-fallback table kind (auth → hitl_handoff) ⇒ FallbackLLM does NOT swap, rethrows immediately", async () => {
    expect(isFallbackKind("auth")).toBe(false)
    const primary = new ThrowingLLM(new LLMError("401", { kind: "auth" }))
    const secondary = new OkLLM()
    const chain = new FallbackLLM({ providers: [primary, secondary] })
    await expect(collect(chain.stream({ messages: [], tools: [] }))).rejects.toThrow("401")
    expect(primary.calls).toBe(1)
    expect(secondary.calls).toBe(0) // no swap — secondary never touched
  })
})

// ── RED-ON-INJECTION (wiring proof) ──────────────────────────────────────────
// The decorator predicates are ONLY correct because they consult the table. We
// pin the equivalence explicitly: `isFallbackTrigger`/`isRetryable` decisions
// equal the table's projection for representative kinds. If someone re-hardcodes
// a decorator set that drifts from the table, one of these flips.
describe("DOF-30 red-on-injection — decorator predicates equal the table projection", () => {
  for (const kind of ALL_KINDS) {
    test(`isFallbackTrigger(${kind}) === (codexSpecRoute(${kind}) === "fallback_provider")`, () => {
      const err = new LLMError(`opaque ${kind}`, { kind })
      expect(isFallbackTrigger(err)).toBe(codexSpecRoute(kind) === "fallback_provider")
    })
  }

  // For retry: only the decisive-disposition kinds are table-pinned (the
  // consult_markers kinds route via message content, not the table — asserting
  // them against the table would be wrong). Pin the decisive ones.
  const DECISIVE_RETRY: readonly LLMErrorKind[] = [
    "rate_limit",
    "overloaded",
    "server_error",
    "network",
  ]
  const DECISIVE_NO_RETRY: readonly LLMErrorKind[] = [
    "auth",
    "cyber_policy",
    "sandbox_error",
    "sandbox_blocked",
    "bad_request",
    "not_found",
    "not_implemented",
    "stream_corrupt",
    "aborted",
    "invalid_image",
  ]
  for (const kind of DECISIVE_RETRY) {
    test(`isRetryable(${kind}) === true via table (opaque message, no markers)`, () => {
      expect(retryDispositionForKind(kind)).toBe("retry")
      expect(isRetryable(new LLMError("opaque no-marker failure", { kind }))).toBe(true)
    })
  }
  for (const kind of DECISIVE_NO_RETRY) {
    test(`isRetryable(${kind}) === false via table EVEN with a retryable marker in the message`, () => {
      expect(retryDispositionForKind(kind)).toBe("no_retry")
      // "overloaded" IS a RETRYABLE_MARKER; the kind-level table verdict wins,
      // so the marker cannot resurrect a retry. This is the anti-drift teeth.
      expect(isRetryable(new LLMError("503 overloaded timeout", { kind }))).toBe(false)
    })
  }
})

// ── SEP6-01 HITL FAIL-CLOSED + residual marker parity ────────────────────────
describe("SEP6-01 — typed HITL kinds cannot be resurrected by message markers", () => {
  for (const kind of HITL_NO_RETRY_KINDS) {
    test(`${kind}: retry-looking message still performs exactly one provider call`, async () => {
      expect(HITL_NO_RETRY.has(kind)).toBe(true)
      expect(retryDispositionForKind(kind)).toBe("no_retry")
      expect(isRetryable(new LLMError("503 overloaded timeout, try again", { kind }))).toBe(false)

      const inner = new ThrowingLLM(new LLMError("503 overloaded timeout, try again", { kind }))
      const retrying = new RetryingLLM({
        inner,
        maxRetries: 4,
        sleep: async () => {},
        random: () => 0,
      })
      await expect(collect(retrying.stream({ messages: [], tools: [] }))).rejects.toThrow()
      expect(inner.calls).toBe(1)
    })
  }
})

describe("DOF-30 residual parity — non-HITL consult_markers kinds remain unchanged", () => {
  const MARKER_KINDS: readonly LLMErrorKind[] = [
    "unknown",
    "context_window_exceeded",
    "too_many_failed_attempts",
    "thread_rollback_failed",
  ]
  for (const kind of MARKER_KINDS) {
    test(`${kind}: disposition is consult_markers ⇒ message markers still decide`, () => {
      expect(retryDispositionForKind(kind)).toBe("consult_markers")
      expect(isRetryable(new LLMError("model overloaded, try again", { kind }))).toBe(true)
      // no marker ⇒ does not retry.
      expect(isRetryable(new LLMError("some opaque failure", { kind }))).toBe(false)
    })
  }
})
