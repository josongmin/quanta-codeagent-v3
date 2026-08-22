/**
 * Hellgate for the LSP-grounding receipt SSOT (jun-23 plan, LSP-00).
 *
 * The whole point of this module is that a benign lifecycle cancellation is
 * NEVER classified as a real failure, and that admission authority rests on a
 * typed outcome rather than a log string. These tests are the teeth on those
 * two invariants plus the pure classifier's full truth table.
 *
 *   GR-01  the outcome union is closed + every member is partitioned by the
 *          three predicates with NO overlap and NO gap (exhaustive).
 *   GR-02  classifier truth table: every signal combination → the documented
 *          outcome, with precedence (cancel > transport > closed > generic).
 *   GR-03  expected-cancel is NEVER a real failure and NEVER admissible.
 *   GR-04  fold projects ordered receipts into per-stage status; last write wins.
 *   GR-05  render is a pure projection (stable, no clock) and degrades cleanly.
 */
import { describe, expect, test } from "bun:test"
import {
  classifyLspGroundingError,
  foldGroundingReceipts,
  isAdmissibleGroundingOutcome,
  isExpectedLifecycleOutcome,
  isLspGroundingOutcome,
  isRealGroundingFailure,
  type LspGroundingErrorSignals,
  type LspGroundingOutcome,
  type LspGroundingReceipt,
  type LspGroundingStatus,
  parseLspGroundingStatus,
  renderLspGroundingStatus,
  summarizeGroundingStatuses,
} from "@/shared"

const ALL_OUTCOMES: readonly LspGroundingOutcome[] = [
  "ok",
  "missing_binary",
  "start_failed",
  "ready_timeout",
  "expected_cancel",
  "fatal_transport",
  "tool_unavailable",
]

const sig = (o: Partial<LspGroundingErrorSignals>): LspGroundingErrorSignals => ({
  aborted: false,
  evicted: false,
  fatalTransport: false,
  closedSentinel: false,
  ...o,
})

describe("LSP-grounding receipt SSOT (LSP-00)", () => {
  test("GR-01: predicates exhaustively + disjointly partition the outcome union", () => {
    // Unconditional assertion first, then narrow: the union has exactly the 7
    // documented members (a silently-added member fails the count, forcing the
    // test author to classify it).
    expect(ALL_OUTCOMES.length).toBe(7)
    expect(new Set(ALL_OUTCOMES).size).toBe(7)

    for (const o of ALL_OUTCOMES) {
      const admissible = isAdmissibleGroundingOutcome(o)
      const expected = isExpectedLifecycleOutcome(o)
      const real = isRealGroundingFailure(o)
      // Exactly one of {admissible, expected, real} is true for every member.
      const trueCount = [admissible, expected, real].filter(Boolean).length
      expect(trueCount).toBe(1)
    }

    // Pinned membership (red-on-injection: flipping any classifier branch trips
    // exactly one of these).
    expect(isAdmissibleGroundingOutcome("ok")).toBe(true)
    expect(isAdmissibleGroundingOutcome("ready_timeout")).toBe(false)
    expect(isExpectedLifecycleOutcome("expected_cancel")).toBe(true)
    expect(isExpectedLifecycleOutcome("fatal_transport")).toBe(false)
    expect(isRealGroundingFailure("ready_timeout")).toBe(true)
    expect(isRealGroundingFailure("fatal_transport")).toBe(true)
    expect(isRealGroundingFailure("missing_binary")).toBe(true)
    expect(isRealGroundingFailure("ok")).toBe(false)
    expect(isRealGroundingFailure("expected_cancel")).toBe(false)
  })

  test("GR-02: classifier truth table — precedence cancel > transport > closed > generic", () => {
    // 1) Cancellation precedence: aborted alone is expected, regardless of stage
    //    or a co-occurring transport flag (a turn abort during a dying server is
    //    still an expected cancel, not an incident).
    expect(classifyLspGroundingError(sig({ aborted: true }), "ready")).toBe("expected_cancel")
    expect(classifyLspGroundingError(sig({ aborted: true }), "launch")).toBe("expected_cancel")
    expect(classifyLspGroundingError(sig({ aborted: true, fatalTransport: true }), "ready")).toBe(
      "expected_cancel",
    )

    // 2) Evict + closed-sentinel is the benign teardown race → expected.
    expect(classifyLspGroundingError(sig({ evicted: true, closedSentinel: true }), "ready")).toBe(
      "expected_cancel",
    )

    // 3) PAIRED CONTROL: evict WITHOUT the closed sentinel and WITHOUT abort is
    //    NOT expected — it is a real failure (this is the exact discriminator
    //    the prior stringly code lacked). Stage decides the generic tail.
    expect(classifyLspGroundingError(sig({ evicted: true }), "ready")).toBe("ready_timeout")
    expect(classifyLspGroundingError(sig({ evicted: true }), "launch")).toBe("start_failed")

    // 4) Fatal transport (no cancel context) → fatal_transport, both stages.
    expect(classifyLspGroundingError(sig({ fatalTransport: true }), "ready")).toBe(
      "fatal_transport",
    )
    expect(classifyLspGroundingError(sig({ fatalTransport: true }), "launch")).toBe(
      "fatal_transport",
    )

    // 5) A bare closed sentinel with NO abort/evict context is NOT silently
    //    demoted to expected — it must stay a real failure (a sibling fatal
    //    teardown can surface here as the sentinel and must reach the warn
    //    channel). It falls through to the stage's generic failure.
    expect(classifyLspGroundingError(sig({ closedSentinel: true }), "ready")).toBe("ready_timeout")
    expect(classifyLspGroundingError(sig({ closedSentinel: true }), "launch")).toBe("start_failed")
    // …but WITH evict context it IS the benign teardown race (paired control).
    expect(classifyLspGroundingError(sig({ evicted: true, closedSentinel: true }), "ready")).toBe(
      "expected_cancel",
    )

    // 6) Generic failure (no signals) splits by stage.
    expect(classifyLspGroundingError(sig({}), "ready")).toBe("ready_timeout")
    expect(classifyLspGroundingError(sig({}), "launch")).toBe("start_failed")
  })

  test("GR-03: expected-cancel is never real and never admissible (the core invariant)", () => {
    const cancel = classifyLspGroundingError(sig({ aborted: true }), "ready")
    const realFail = classifyLspGroundingError(sig({ fatalTransport: true }), "ready")
    expect(cancel).toBe("expected_cancel")
    expect(realFail).toBe("fatal_transport")
    // The discriminator the whole plan turns on:
    expect(isRealGroundingFailure(cancel)).toBe(false)
    expect(isRealGroundingFailure(realFail)).toBe(true)
    expect(isAdmissibleGroundingOutcome(cancel)).toBe(false)
  })

  test("GR-04: fold projects ordered receipts per-stage; last write wins", () => {
    expect(foldGroundingReceipts([])).toBeUndefined()

    const receipts: LspGroundingReceipt[] = [
      { backend: "pyright", language: "python", stage: "launch", outcome: "ok" },
      {
        backend: "pyright",
        language: "python",
        stage: "ready",
        outcome: "ready_timeout",
        durationMs: 12,
        reason: "budget exhausted",
        file: "a.py",
      },
    ]
    const status = foldGroundingReceipts(receipts)
    expect(status).toEqual({
      backend: "pyright",
      language: "python",
      launch: "ok",
      ready: "ready_timeout",
      durationMs: 12,
      reason: "budget exhausted",
    })

    // Last write per stage wins: a re-probe that succeeds supersedes the earlier
    // ready_timeout (and clears stale reason via the newer non-empty reason).
    const reprobed = foldGroundingReceipts([
      ...receipts,
      { backend: "pyright", language: "python", stage: "ready", outcome: "ok", durationMs: 4 },
    ])
    expect(reprobed?.ready).toBe("ok")
    expect(reprobed?.durationMs).toBe(4)
  })

  test("GR-05: render is a stable pure projection and degrades cleanly", () => {
    expect(
      renderLspGroundingStatus({
        backend: "pyright",
        language: "python",
        launch: "ok",
        ready: "ready_timeout",
        durationMs: 12,
        reason: "budget exhausted",
      }),
    ).toBe("pyright/python launch=ok ready=ready_timeout (12ms): budget exhausted")

    // Empty/missing fields must not produce "undefined" or trailing junk.
    expect(renderLspGroundingStatus({ backend: "", language: "", launch: "ok" })).toBe(
      "lsp/? launch=ok",
    )
    // Same input → same output (no clock / no randomness).
    const s = { backend: "gopls", language: "go", ready: "ok" as const }
    expect(renderLspGroundingStatus(s)).toBe(renderLspGroundingStatus(s))
  })

  test("GR-06: parse round-trips a valid status and rejects/sanitizes junk", () => {
    expect(isLspGroundingOutcome("ready_timeout")).toBe(true)
    expect(isLspGroundingOutcome("nope")).toBe(false)
    expect(isLspGroundingOutcome(undefined)).toBe(false)

    const valid: LspGroundingStatus = {
      backend: "pyright",
      language: "pyright-langserver",
      launch: "ok",
      ready: "ready_timeout",
      durationMs: 12,
      reason: "budget exhausted",
    }
    expect(parseLspGroundingStatus(valid)).toEqual(valid)

    // ROUND-TRIP through the SSOT: a folded status survives parse unchanged.
    const folded = foldGroundingReceipts([
      { backend: "pyright", language: "py", stage: "launch", outcome: "ok" },
      { backend: "pyright", language: "py", stage: "ready", outcome: "ok", durationMs: 4 },
    ])
    expect(parseLspGroundingStatus(folded)).toEqual(folded)

    // Junk inputs.
    expect(parseLspGroundingStatus(null)).toBeUndefined()
    expect(parseLspGroundingStatus("nope")).toBeUndefined()
    expect(parseLspGroundingStatus({ language: "py" })).toBeUndefined() // missing backend
    // Unknown outcome strings are DROPPED per-stage (forward-compatible), not poison.
    const sanitized = parseLspGroundingStatus({
      backend: "pyright",
      language: "py",
      launch: "ok",
      ready: "from_the_future",
      durationMs: "twelve",
    })
    expect(sanitized).toEqual({ backend: "pyright", language: "py", launch: "ok" })
  })

  test("GR-07: summarize folds per-stage outcome histograms + sorted ready durations (LSP-03)", () => {
    const rows: LspGroundingStatus[] = [
      { backend: "pyright", language: "py", launch: "ok", ready: "ok", durationMs: 30 },
      { backend: "pyright", language: "py", launch: "ok", ready: "ready_timeout", durationMs: 120 },
      { backend: "pyright", language: "py", launch: "ok", ready: "ready_timeout", durationMs: 90 },
      { backend: "pyright", language: "py", launch: "missing_binary" },
      { backend: "pyright", language: "py", ready: "expected_cancel" },
      { backend: "pyright", language: "py", ready: "fatal_transport" },
    ]
    const s = summarizeGroundingStatuses(rows)
    expect(s.total).toBe(6)
    expect(s.launchOutcomes).toEqual({ ok: 3, missing_binary: 1 })
    expect(s.readyOutcomes).toEqual({
      ok: 1,
      ready_timeout: 2,
      expected_cancel: 1,
      fatal_transport: 1,
    })
    expect(s.readyTimeouts).toBe(2)
    expect(s.expectedCancels).toBe(1)
    expect(s.fatalTransports).toBe(1)
    // Durations sorted ascending so a caller reads min/median/max in one pass.
    expect(s.readyDurationsMs).toEqual([30, 90, 120])

    const empty = summarizeGroundingStatuses([])
    expect(empty.total).toBe(0)
    expect(empty.readyDurationsMs).toEqual([])
  })
})
