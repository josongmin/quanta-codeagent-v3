/**
 * WIRE-PROOF for DOF-30a (recovery-router disposition = WIRE).
 *
 * The 16-kind → 6-action `codexSpecRoute` table (src/llm/retry/codex-spec-router.ts)
 * was, at base revision b92b3798f, ONLY barrel-exported and had ZERO production
 * consumer: the live turn-recovery owner `decideOnStreamError` (src/agent/recovery.ts)
 * routed purely through the 3-way `classifyLLMError` (retryable/prompt_too_long/fatal)
 * and NEVER consulted `codexSpecRoute`. This file drives the REAL consumer
 * (`decideOnStreamError`, the function `src/agent/loop.ts` calls on every stream
 * error) and asserts the retry/HITL/compact decision now flows THROUGH the
 * Codex router — via observable behaviour that the pre-wire pure path could not
 * produce.
 *
 * Non-vacuity strategy (red-on-injection by construction): every ON assertion
 * keys on a decision the OLD `classifyLLMError`-only path physically could not
 * emit —
 *   - HITL kinds (`auth` / `cyber_policy` / `sandbox_error`) surface the
 *     `"operator intervention"` reason prefix, which exists ONLY in
 *     `decideTypedStreamError`'s `hitl_handoff` branch (the router wire). The
 *     legacy path collapses these to a bare `{ do: "error", reason: message }`
 *     with NO prefix. If the wire is reverted (router call removed), the reason
 *     loses the prefix and these tests go RED.
 *   - `context_window_exceeded` carried on a kind but with a NON-PTL message
 *     routes to `{ do: "compact" }` via the router. The legacy path (no PTL
 *     marker, kind not in RETRYABLE_KINDS) fell through to `{ do: "error" }`.
 *     Remove the wire and this test goes RED.
 *
 * Paired-control (OFF-parity / no-regression): the previously-hardcoded
 * retryable kinds (`overloaded`/`rate_limit`/`server_error`/`network`) still
 * yield the SAME `{ do: "backoff" }` decision AND still consume a stream-retry
 * slot exactly as before — the win is dedup onto ONE policy table, not a
 * behaviour change.
 */

import { describe, expect, test } from "bun:test"
import { decideOnStreamError, freshRecovery, type RecoveryAction } from "@/agent/loop"
import { codexSpecRoute } from "@/llm"
import { LLMError, type LLMErrorKind } from "@/shared"

/** Non-context-window wording so the loop's message-based PTL scan MISSES —
 *  isolates the decision to the KIND-driven typed route, not the legacy marker
 *  path (which would otherwise mask which mechanism fired). */
const OPAQUE = "some opaque provider failure with no marker words"

describe("recovery-router WIRE — decideOnStreamError routes through codexSpecRoute", () => {
  // ── ON-PROOF: HITL kinds surface the router-only "operator intervention" reason ──
  // codexSpecRoute(auth|cyber_policy|sandbox_error) === "hitl_handoff". The
  // ONLY code path that turns that action into a reason string is the wired
  // `decideTypedStreamError` branch. The legacy `classifyLLMError` path emits a
  // bare message with no prefix. This is the load-bearing fingerprint.
  const HITL_KINDS: readonly LLMErrorKind[] = ["auth", "cyber_policy", "sandbox_error"]
  for (const kind of HITL_KINDS) {
    test(`${kind} → codex "hitl_handoff" ⇒ decideOnStreamError emits the router-only HITL reason`, () => {
      // ORACLE precondition: the table says this kind is HITL.
      expect(codexSpecRoute(kind)).toBe("hitl_handoff")

      const rec = freshRecovery()
      const action = decideOnStreamError(new LLMError(OPAQUE, { kind }), OPAQUE, rec)

      expect(action.do).toBe("error")
      // FINGERPRINT of the router wire — the legacy path cannot produce this.
      const reason = action.do === "error" ? action.reason : ""
      expect(reason).toContain("operator intervention")
      // A HITL handoff is terminal: it must NOT have burned a retry slot.
      expect(rec.streamRetries).toBe(0)
    })
  }

  // ── ON-PROOF: context_window_exceeded (non-PTL msg) compacts via the typed route ──
  // The legacy path saw a kind not in RETRYABLE_KINDS and no PTL marker ⇒
  // { do: "error" }. The wired router maps the KIND to reactive_compaction.
  test('context_window_exceeded KIND (non-PTL message) ⇒ { do: "compact" } via the router (legacy path was "error")', () => {
    const kind: LLMErrorKind = "context_window_exceeded"
    expect(codexSpecRoute(kind)).toBe("reactive_compaction")

    const rec = freshRecovery()
    const action = decideOnStreamError(new LLMError(OPAQUE, { kind }), OPAQUE, rec)

    expect(action.do).toBe("compact")
    // Compaction does not consume a stream-retry slot.
    expect(rec.streamRetries).toBe(0)
  })

  // ── COVERAGE (not a wire-discriminator): too_many_failed_attempts stays terminal ──
  // HONESTY NOTE: this kind lands terminal under BOTH the legacy path (it is in
  // neither RETRYABLE_KINDS nor a PTL marker ⇒ classifyLLMError=fatal) AND the
  // wired router (codex → "fatal"), so removing the wire does NOT flip it. It is
  // therefore a coverage/parity assertion, NOT proof the wire fired — the HITL +
  // compact tests above carry the red-on-injection teeth. Kept so the Codex-spec
  // budget-burned kind has an explicit terminal assertion through the consumer.
  test('too_many_failed_attempts → codex "fatal" ⇒ terminal error, no retry slot burned (parity, not a wire discriminator)', () => {
    const kind: LLMErrorKind = "too_many_failed_attempts"
    expect(codexSpecRoute(kind)).toBe("fatal")

    const rec = freshRecovery()
    const action = decideOnStreamError(new LLMError(OPAQUE, { kind }), OPAQUE, rec)

    expect(action.do).toBe("error")
    expect(rec.streamRetries).toBe(0)
  })
})

describe("recovery-router WIRE — paired-control: previously-hardcoded kinds retry identically", () => {
  // These four kinds were in the legacy `RETRYABLE_KINDS` set AND the codex
  // table routes them to a retry-eligible action (retry_after_backoff /
  // fallback_provider). Post-wire the decision must be BYTE-IDENTICAL to the
  // legacy path: a { do: "backoff", attempt: 0 } that consumes one retry slot.
  // This is the no-regression guarantee — the win is a single policy table, not
  // a behaviour change for the already-handled kinds.
  const RETRY_KINDS: readonly LLMErrorKind[] = ["overloaded", "rate_limit", "server_error", "network"]

  for (const kind of RETRY_KINDS) {
    test(`${kind} → still { do: "backoff", attempt: 0 } and consumes a retry slot (parity)`, () => {
      const action = codexSpecRoute(kind)
      // ORACLE precondition: codex routes this to a retry-eligible action.
      expect(action === "retry_after_backoff" || action === "fallback_provider").toBe(true)

      const rec = freshRecovery()
      const decision = decideOnStreamError(new LLMError(`provider says ${kind}`, { kind }), "msg", rec)

      const expected: RecoveryAction = { do: "backoff", attempt: 0 }
      expect(decision).toEqual(expected)
      // The retry slot WAS consumed (identical to the legacy retryable path).
      expect(rec.streamRetries).toBe(1)
    })
  }

  test("retry budget still exhausts to a terminal error after MAX_TURN_STREAM_RETRIES (no infinite retry)", () => {
    const kind: LLMErrorKind = "rate_limit"
    const rec = freshRecovery()
    // Drive it past the same-turn stream-retry cap; the last decision must be
    // terminal, proving the router path honors the SAME bounded budget the
    // legacy path did (no unbounded retry regression).
    let last = decideOnStreamError(new LLMError("429", { kind }), "429", rec)
    for (let i = 0; i < 10 && last.do === "backoff"; i++) {
      last = decideOnStreamError(new LLMError("429", { kind }), "429", rec)
    }
    expect(last.do).toBe("error")
  })
})

describe("recovery-router WIRE — CHARACTERIZATION of kinds whose behaviour the wire CHANGED", () => {
  // ⚠️ These two kinds are NOT parity: the wire flipped their outer-recovery
  // decision vs the legacy `classifyLLMError` path. Pinned here so the change is
  // VISIBLE (was untested by the concurrent wire's own e2e). The parent board
  // must adjudicate `not_implemented` (a real behaviour change — measure-first
  // flip candidate, not a free dedup) before treating the wire as pure parity.

  test('REGRESSION-RISK: not_implemented now RETRIES (was terminal in legacy FATAL_KINDS)', () => {
    const kind: LLMErrorKind = "not_implemented"
    // Codex table routes it to `fallback_provider`; at the OUTER owner (past any
    // FallbackLLM chain) that collapses to a same-turn backoff RETRY.
    expect(codexSpecRoute(kind)).toBe("fallback_provider")

    const rec = freshRecovery()
    const decision = decideOnStreamError(new LLMError("stub adapter", { kind }), "stub adapter", rec)

    // WIRED behaviour: retries. LEGACY behaviour was { do: "error" } (FATAL_KINDS
    // in src/agent/retry.ts lists `not_implemented`: a stub adapter throws
    // identically every call, so same-turn retry is pure waste). This assertion
    // documents the FLIP — flip it back to `.toBe("error")` if the board gates
    // the wire to preserve legacy `not_implemented` terminality.
    expect(decision.do).toBe("backoff")
    expect(rec.streamRetries).toBe(1)
  })

  test('CHANGED (intended): thread_rollback_failed now COMPACTS (was fatal in legacy)', () => {
    const kind: LLMErrorKind = "thread_rollback_failed"
    // Codex routes it to reactive_compaction (rebuild a shorter prefix). Legacy
    // had no structured handling ⇒ classifyLLMError=fatal. The compact route is
    // the intended Codex-spec improvement, but pin it so it is not silent.
    expect(codexSpecRoute(kind)).toBe("reactive_compaction")

    const rec = freshRecovery()
    const decision = decideOnStreamError(new LLMError("rollback failed", { kind }), "rollback failed", rec)

    expect(decision.do).toBe("compact")
  })
})
