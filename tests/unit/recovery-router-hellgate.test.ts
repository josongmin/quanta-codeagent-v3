/**
 * Hellgate for `src/llm/retry/{port,recovery-router,codex-spec-router}.ts`
 * (ADR-0214).
 *
 * Pins the 16-kind → 6-action Codex-spec routing table and four negative
 * invariants. 20+ hard cases (well above the spec's "16+" floor).
 */

import { describe, expect, test } from "bun:test"
import {
  CodexSpecRouter,
  codexSpecRoute,
  codexSpecRouterEmittedActions,
  createDefaultRecoveryRouter,
  type RecoveryAction,
  type RecoveryRouter,
} from "@/llm"
import type { LLMErrorKind } from "@/shared"

describe("codexSpecRoute — 16 kinds × correct action", () => {
  const TABLE: ReadonlyArray<{ kind: LLMErrorKind; action: RecoveryAction }> = [
    { kind: "overloaded", action: "fallback_provider" },
    { kind: "rate_limit", action: "retry_after_backoff" },
    { kind: "server_error", action: "fallback_provider" },
    { kind: "network", action: "fallback_provider" },
    { kind: "auth", action: "hitl_handoff" },
    { kind: "bad_request", action: "fatal" },
    { kind: "not_found", action: "fatal" },
    { kind: "not_implemented", action: "fallback_provider" },
    { kind: "stream_corrupt", action: "fatal" },
    { kind: "aborted", action: "fatal" },
    { kind: "unknown", action: "fatal" },
    { kind: "context_window_exceeded", action: "reactive_compaction" },
    { kind: "cyber_policy", action: "hitl_handoff" },
    { kind: "too_many_failed_attempts", action: "fatal" },
    { kind: "thread_rollback_failed", action: "reactive_compaction" },
    { kind: "sandbox_error", action: "hitl_handoff" },
  ]

  for (const { kind, action } of TABLE) {
    test(`${kind} → ${action}`, () => {
      expect(codexSpecRoute(kind)).toBe(action)
    })
  }

  test("the table covers exactly 16 kinds (compile-time exhaustiveness)", () => {
    expect(TABLE.length).toBe(16)
    // Set-equivalence: every kind appears exactly once.
    const seen = new Set<LLMErrorKind>()
    for (const { kind } of TABLE) seen.add(kind)
    expect(seen.size).toBe(16)
  })
})

describe("CodexSpecRouter — class wrapper parity with pure function", () => {
  test("class.route(k) === codexSpecRoute(k) for every kind", () => {
    const router: RecoveryRouter = new CodexSpecRouter()
    const kinds: readonly LLMErrorKind[] = [
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
    ]
    for (const k of kinds) {
      expect(router.route(k)).toBe(codexSpecRoute(k))
    }
  })

  test("createDefaultRecoveryRouter() returns a Codex-spec router (parity)", () => {
    const router = createDefaultRecoveryRouter()
    expect(router.route("rate_limit")).toBe("retry_after_backoff")
    expect(router.route("context_window_exceeded")).toBe("reactive_compaction")
    expect(router.route("cyber_policy")).toBe("hitl_handoff")
  })
})

describe("RecoveryRouter — negative invariants (the spec's required negatives)", () => {
  // The user's spec calls out these specific negatives. We pin them as
  // hellgate cases so a future "looks-cleaner" refactor that breaks them
  // turns red here, not in production.

  test("context_window_exceeded MUST be reactive_compaction, NOT retry_after_backoff", () => {
    // Retrying the same oversized prompt fails identically — must compact first.
    expect(codexSpecRoute("context_window_exceeded")).toBe("reactive_compaction")
    expect(codexSpecRoute("context_window_exceeded")).not.toBe("retry_after_backoff")
    expect(codexSpecRoute("context_window_exceeded")).not.toBe("fatal")
  })

  test("cyber_policy MUST be hitl_handoff, NOT fallback_provider", () => {
    // Policy refusal — no other provider will reverse the decision.
    expect(codexSpecRoute("cyber_policy")).toBe("hitl_handoff")
    expect(codexSpecRoute("cyber_policy")).not.toBe("fallback_provider")
    expect(codexSpecRoute("cyber_policy")).not.toBe("retry_after_backoff")
  })

  test("aborted MUST NOT be retry_same_turn (negative invariant)", () => {
    // The spec calls out: activeTurnNotSteerable → retry_same_turn is NOT
    // what we want. Our turn-lifecycle never re-issues an identical in-flight
    // stream — the abort is propagated.
    expect(codexSpecRoute("aborted")).not.toBe("retry_same_turn")
    expect(codexSpecRoute("aborted")).toBe("fatal")
  })

  test("too_many_failed_attempts MUST be fatal, NOT retry_after_backoff", () => {
    // Critical: this is the "budget burned" kind. Retrying after backoff
    // would burn even more budget for zero gain. The kind exists precisely
    // to break the retry loop.
    expect(codexSpecRoute("too_many_failed_attempts")).toBe("fatal")
    expect(codexSpecRoute("too_many_failed_attempts")).not.toBe("retry_after_backoff")
  })
})

describe("RecoveryRouter — OFF-parity (default-OFF byte-identical guard)", () => {
  // The router is a pure typed mapping. There is no "OFF" mode that returns
  // a different action — the OFF mode is "do not call the router at all"
  // (which leaves the legacy RetryingLLM/FallbackLLM path byte-identical).
  // Pin this so future contributors don't add an env knob that mutates the
  // pure function's output mid-program.

  test("codexSpecRoute is referentially transparent — calling N times yields the same action", () => {
    for (let i = 0; i < 10; i++) {
      expect(codexSpecRoute("overloaded")).toBe("fallback_provider")
      expect(codexSpecRoute("rate_limit")).toBe("retry_after_backoff")
      expect(codexSpecRoute("auth")).toBe("hitl_handoff")
    }
  })

  test("router output is independent of process.env mutations", () => {
    const before = codexSpecRoute("rate_limit")
    const prev = process.env.QUANTA_RECOVERY_ROUTER_OFF
    try {
      process.env.QUANTA_RECOVERY_ROUTER_OFF = "1"
      const during = codexSpecRoute("rate_limit")
      expect(during).toBe(before)
    } finally {
      if (prev === undefined) delete process.env.QUANTA_RECOVERY_ROUTER_OFF
      else process.env.QUANTA_RECOVERY_ROUTER_OFF = prev
    }
  })

  test("codexSpecRouterEmittedActions exports the audit-tracking set", () => {
    // Membership only — future routers may emit additional actions.
    expect(codexSpecRouterEmittedActions.has("fallback_provider")).toBe(true)
    expect(codexSpecRouterEmittedActions.has("retry_after_backoff")).toBe(true)
    expect(codexSpecRouterEmittedActions.has("hitl_handoff")).toBe(true)
    expect(codexSpecRouterEmittedActions.has("fatal")).toBe(true)
    expect(codexSpecRouterEmittedActions.has("reactive_compaction")).toBe(true)
    // retry_same_turn is in the type but NOT emitted by this concrete router.
    expect(codexSpecRouterEmittedActions.has("retry_same_turn")).toBe(false)
  })
})
