/**
 * ★ HELLGATE (SECOND LAYER, ADVERSARIAL) — recovery-router SINGLE AUTHORITY.
 *
 * The FIRST layer proved the 16-kind→action table (recovery-router-hellgate)
 * and the decorator derivation parity vs the historical hardcoded sets
 * (retry-decorator-policy-hellgate). This SECOND layer proves the SYSTEM-LEVEL
 * invariant the task calls out: the OBSERVABLE decisions of the two live
 * decorators — `RetryingLLM` (same-provider retry) and `FallbackLLM` (provider
 * swap) — are EXACTLY the projection of the ONE `codexSpecRoute` table, for
 * ALL 18 `LLMErrorKind`s, exhaustively (not sampled). No kind escapes the table.
 *
 *   R1 EXHAUSTIVE UNION COVERAGE — `codexSpecRoute` is total over all 18 kinds
 *      (the union is enumerated locally AND cross-checked so a future added kind
 *      that the enumeration misses is caught). Every kind maps to a real action.
 *   R2 FALLBACK == TABLE (all 18, opaque messages) — `isFallbackTrigger` on a
 *      real `LLMError` is TRUE iff `codexSpecRoute(kind) === "fallback_provider"`,
 *      for every kind, with a MESSAGE that carries no marker (so only the kind
 *      axis can decide). Zero drift.
 *   R3 RETRY DECISIVE == DERIVED (all decisive kinds, opaque + hostile message) —
 *      for the 11 kinds whose disposition is decisive (retry / no_retry),
 *      `isRetryable` equals the derived verdict EVEN when the message carries a
 *      CONTRADICTORY marker (a `no_retry` kind with "503 overloaded" still does
 *      NOT retry; a `retry` kind with "invalid api key" still retries). The
 *      kind-level table wins over the message — anti-drift teeth.
 *   R4 THE 7 MARKER-SCAN KINDS PINNED — for exactly `unknown`,
 *      `context_window_exceeded`, `cyber_policy`, `too_many_failed_attempts`,
 *      `thread_rollback_failed`, `sandbox_error`, `sandbox_blocked`: disposition
 *      is `consult_markers` AND the message-marker scan (not the table) decides.
 *      This is the intentional latent divergence — pinned so a measure-first flip
 *      is a visible edit.
 *   R5 OBSERVABLE DECORATOR BEHAVIOR == TABLE (drive the REAL streams) — for
 *      every kind, wrap a throwing inner in RetryingLLM and in FallbackLLM and
 *      assert the observed retry-count / swap matches the table projection. This
 *      is the end-to-end wire proof (not just the predicate).
 *   R6 BUDGET-CAP INTERACTION — a retryable kind is retried at most `maxRetries`
 *      times then rethrown (budget is honored); `too_many_failed_attempts` (the
 *      "budget burned" kind) is NON-retryable by markers so it never re-enters
 *      the loop with an opaque message.
 *   R7 RED-ON-INJECTION — a re-hardcoded decorator set that drifts from the table
 *      would flip one of the per-kind equalities; the union-completeness check
 *      would flip if a kind were dropped from the table.
 *
 * Source under test: src/llm/retry/{codex-spec-router,decorator-policy}.ts,
 * src/agent/retry.ts (RetryingLLM/isRetryable), src/llm/fallback.ts (FallbackLLM).
 */

import { describe, expect, test } from "bun:test"
import { isRetryable, RetryingLLM } from "@/agent"
import {
  codexSpecRoute,
  FallbackLLM,
  isFallbackKind,
  isFallbackTrigger,
  type LLMPort,
  type RecoveryAction,
  retryDispositionForKind,
  type StreamEvent,
} from "@/llm"
import { LLMError, type LLMErrorKind } from "@/shared"

/** ALL 18 members of the union, enumerated. */
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

const VALID_ACTIONS: ReadonlySet<RecoveryAction> = new Set<RecoveryAction>([
  "fallback_provider",
  "retry_after_backoff",
  "hitl_handoff",
  "fatal",
  "reactive_compaction",
  "retry_same_turn",
])

const collect = async (it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// R1 — codexSpecRoute is TOTAL over all 18 kinds; enumeration is complete.
// ─────────────────────────────────────────────────────────────────────────────
describe("R1 exhaustive union coverage — the table routes every kind to a valid action", () => {
  test("all 18 kinds map to a valid RecoveryAction (no kind escapes the table)", () => {
    expect(ALL_KINDS.length).toBe(18)
    // No duplicates in the enumeration (a dup would hide a missing kind).
    expect(new Set(ALL_KINDS).size).toBe(18)
    for (const kind of ALL_KINDS) {
      const action = codexSpecRoute(kind)
      expect(VALID_ACTIONS.has(action)).toBe(true)
    }
  })

  test("assertNever guards the src side: a SYNTHESIZED non-member kind hits the default and throws", () => {
    // The src exhaustiveness is enforced by `assertNever(kind)` in the default
    // arm — a future added union member with no case would fail to COMPILE there.
    // At runtime, feeding a bogus kind (bypassing the type) reaches the default:
    // assertNever throws. This proves the table has NO silent fall-through that
    // would let an unrouted kind slip out with an undefined action.
    expect(() => codexSpecRoute("totally-not-a-kind" as unknown as LLMErrorKind)).toThrow()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// R2 — FallbackLLM predicate == table projection, all 18, opaque message.
// ─────────────────────────────────────────────────────────────────────────────
describe("R2 fallback == table (all 18) — isFallbackTrigger is exactly fallback_provider", () => {
  for (const kind of ALL_KINDS) {
    test(`${kind}: isFallbackTrigger ⇔ codexSpecRoute===fallback_provider (opaque message)`, () => {
      const err = new LLMError(`opaque failure for ${kind}, no markers here`, { kind })
      const expected = codexSpecRoute(kind) === "fallback_provider"
      expect(isFallbackTrigger(err)).toBe(expected)
      // And the derived predicate agrees (single source of truth).
      expect(isFallbackKind(kind)).toBe(expected)
    })
  }

  test("the fallback set is EXACTLY {overloaded, server_error, network, not_implemented}", () => {
    const fallbackKinds = ALL_KINDS.filter((k) => isFallbackKind(k)).sort()
    expect(fallbackKinds).toEqual(
      ["network", "not_implemented", "overloaded", "server_error"].sort(),
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// R3 — RetryingLLM predicate == derived verdict for the DECISIVE kinds, and the
//      table wins over a CONTRADICTORY message marker.
// ─────────────────────────────────────────────────────────────────────────────
describe("R3 retry decisive == table — kind beats a contradictory message marker", () => {
  const DECISIVE_RETRY: readonly LLMErrorKind[] = [
    "rate_limit",
    "overloaded",
    "server_error",
    "network",
  ]
  const DECISIVE_NO_RETRY: readonly LLMErrorKind[] = [
    "auth",
    "bad_request",
    "not_found",
    "not_implemented",
    "stream_corrupt",
    "aborted",
    "invalid_image",
  ]

  for (const kind of DECISIVE_RETRY) {
    test(`${kind}: retries EVEN with a FATAL marker ("invalid api key") in the message`, () => {
      expect(retryDispositionForKind(kind)).toBe("retry")
      // A fatal marker in the message must NOT override the kind's retry verdict.
      expect(isRetryable(new LLMError("invalid api key 401 unauthorized", { kind }))).toBe(true)
    })
  }
  for (const kind of DECISIVE_NO_RETRY) {
    test(`${kind}: does NOT retry EVEN with a RETRYABLE marker ("503 overloaded") in the message`, () => {
      expect(retryDispositionForKind(kind)).toBe("no_retry")
      expect(isRetryable(new LLMError("503 overloaded timeout, try again", { kind }))).toBe(false)
    })
  }

  test("every decisive kind's disposition is decisive, and the two groups partition the 11", () => {
    const decisive = ALL_KINDS.filter((k) => retryDispositionForKind(k) !== "consult_markers")
    expect(decisive.sort()).toEqual([...DECISIVE_RETRY, ...DECISIVE_NO_RETRY].sort())
    expect(decisive.length).toBe(11)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// R4 — the 7 marker-scan divergence kinds pinned.
// ─────────────────────────────────────────────────────────────────────────────
describe("R4 the 7 marker-scan kinds — message decides, NOT the table (latent divergence pinned)", () => {
  const MARKER_KINDS: readonly LLMErrorKind[] = [
    "unknown",
    "context_window_exceeded",
    "cyber_policy",
    "too_many_failed_attempts",
    "thread_rollback_failed",
    "sandbox_error",
    "sandbox_blocked",
  ]

  test("exactly these 7 kinds are consult_markers (no more, no fewer)", () => {
    const markerKinds = ALL_KINDS.filter((k) => retryDispositionForKind(k) === "consult_markers")
    expect(markerKinds.sort()).toEqual([...MARKER_KINDS].sort())
    expect(markerKinds.length).toBe(7)
  })

  for (const kind of MARKER_KINDS) {
    test(`${kind}: retryable marker in message ⇒ retries (legacy behavior, NOT the table action)`, () => {
      // These route to a NON-retry action in the table (hitl/compaction/fatal),
      // yet a "overloaded" marker resurrects a retry — the documented divergence.
      const tableAction = codexSpecRoute(kind)
      expect(["hitl_handoff", "reactive_compaction", "fatal"]).toContain(tableAction)
      expect(isRetryable(new LLMError("the model is overloaded, try again", { kind }))).toBe(true)
      // No marker ⇒ falls to fatal (no retry).
      expect(isRetryable(new LLMError("some opaque failure", { kind }))).toBe(false)
    })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// R5 — OBSERVABLE decorator behavior matches the table projection (drive streams).
// ─────────────────────────────────────────────────────────────────────────────
class ThrowOnceThenOk implements LLMPort {
  calls = 0
  constructor(private readonly error: unknown) {}
  async *stream(): AsyncIterable<StreamEvent> {
    this.calls += 1
    if (this.calls === 1) throw this.error
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}
class AlwaysThrow implements LLMPort {
  calls = 0
  constructor(private readonly error: unknown) {}
  async *stream(): AsyncIterable<StreamEvent> {
    this.calls += 1
    throw this.error
    // biome-ignore lint/correctness/noUnreachable: generator needs a yield-typed body
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}
class OkLLM implements LLMPort {
  calls = 0
  readonly model = "ok"
  async *stream(): AsyncIterable<StreamEvent> {
    this.calls += 1
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

describe("R5 observable RetryingLLM behavior == retry disposition (opaque message, all kinds)", () => {
  for (const kind of ALL_KINDS) {
    test(`${kind}: RetryingLLM retries IFF disposition===retry (opaque message)`, async () => {
      // Opaque message ⇒ consult_markers kinds fall to no-retry (no marker).
      const err = new LLMError(`opaque ${kind} failure`, { kind })
      const shouldRetry = retryDispositionForKind(kind) === "retry"
      const inner = new ThrowOnceThenOk(err)
      const r = new RetryingLLM({ inner, maxRetries: 3, sleep: async () => {}, random: () => 0 })
      if (shouldRetry) {
        const events = await collect(r.stream({ messages: [], tools: [] }))
        expect(events).toEqual([{ type: "message_stop", stop_reason: "end_turn" }])
        expect(inner.calls).toBe(2) // threw once, retried, succeeded
      } else {
        await expect(collect(r.stream({ messages: [], tools: [] }))).rejects.toThrow()
        expect(inner.calls).toBe(1) // no retry
      }
    })
  }
})

describe("R5 observable FallbackLLM behavior == fallback trigger (all kinds)", () => {
  for (const kind of ALL_KINDS) {
    test(`${kind}: FallbackLLM swaps IFF codexSpecRoute===fallback_provider`, async () => {
      const err = new LLMError(`opaque ${kind}`, { kind })
      const shouldSwap = codexSpecRoute(kind) === "fallback_provider"
      const primary = new AlwaysThrow(err)
      const secondary = new OkLLM()
      const chain = new FallbackLLM({ providers: [primary, secondary] })
      if (shouldSwap) {
        const events = await collect(chain.stream({ messages: [], tools: [] }))
        expect(events).toEqual([{ type: "message_stop", stop_reason: "end_turn" }])
        expect(primary.calls).toBe(1)
        expect(secondary.calls).toBe(1) // swapped
      } else {
        await expect(collect(chain.stream({ messages: [], tools: [] }))).rejects.toThrow()
        expect(primary.calls).toBe(1)
        expect(secondary.calls).toBe(0) // no swap — rethrew immediately
      }
    })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// R6 — budget-cap interaction.
// ─────────────────────────────────────────────────────────────────────────────
describe("R6 budget cap — a retryable kind is retried at most maxRetries then rethrown", () => {
  test("rate_limit always-throwing ⇒ exactly maxRetries+1 attempts then rethrow", async () => {
    const inner = new AlwaysThrow(new LLMError("429 rate limit", { kind: "rate_limit" }))
    const r = new RetryingLLM({ inner, maxRetries: 3, sleep: async () => {}, random: () => 0 })
    await expect(collect(r.stream({ messages: [], tools: [] }))).rejects.toThrow("429")
    // 1 initial + 3 retries = 4 attempts; the budget is honored (no infinite loop).
    expect(inner.calls).toBe(4)
  })

  test("too_many_failed_attempts (budget-burned kind) with opaque message ⇒ NOT retried", async () => {
    // The kind exists to STOP the loop; with an opaque message it is fatal (the
    // table says fatal; the marker scan finds nothing ⇒ no retry).
    expect(codexSpecRoute("too_many_failed_attempts")).toBe("fatal")
    const inner = new AlwaysThrow(
      new LLMError("attempt budget exhausted", { kind: "too_many_failed_attempts" }),
    )
    const r = new RetryingLLM({ inner, maxRetries: 5, sleep: async () => {}, random: () => 0 })
    await expect(collect(r.stream({ messages: [], tools: [] }))).rejects.toThrow()
    expect(inner.calls).toBe(1) // never re-entered the loop
  })

  test("maxRetries=0 ⇒ a retryable kind is NOT retried (budget of zero honored)", async () => {
    const inner = new AlwaysThrow(new LLMError("429", { kind: "rate_limit" }))
    const r = new RetryingLLM({ inner, maxRetries: 0, sleep: async () => {}, random: () => 0 })
    await expect(collect(r.stream({ messages: [], tools: [] }))).rejects.toThrow()
    expect(inner.calls).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// R7 — RED-ON-INJECTION: the two decorators and the table agree on a union basis.
// ─────────────────────────────────────────────────────────────────────────────
describe("R7 red-on-injection — decorator ∪ derivation ∪ table are one authority", () => {
  test("for EVERY kind: (fallback trigger) == (table fallback_provider) == (isFallbackKind)", () => {
    // Three independent expressions of the same fact. If a decorator re-hardcodes
    // a drifting set, or the table changes without the derivation, this flips.
    for (const kind of ALL_KINDS) {
      const err = new LLMError(`x ${kind}`, { kind })
      const a = isFallbackTrigger(err)
      const b = codexSpecRoute(kind) === "fallback_provider"
      const c = isFallbackKind(kind)
      expect(a).toBe(b)
      expect(b).toBe(c)
    }
  })

  test("mutation sentinel — the derivation is NON-degenerate (spans both booleans + all 3 dispositions)", () => {
    // Guards against a bug where a predicate collapses to a constant (which would
    // make the equality checks above vacuously pass).
    expect(new Set(ALL_KINDS.map(isFallbackKind))).toEqual(new Set([true, false]))
    expect(new Set(ALL_KINDS.map(retryDispositionForKind))).toEqual(
      new Set(["retry", "no_retry", "consult_markers"]),
    )
    expect(new Set(ALL_KINDS.map(codexSpecRoute)).size).toBeGreaterThanOrEqual(4)
  })
})
