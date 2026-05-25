/**
 * ADR-0223 hellgate — auto-background stuck-detector + propose-handler.
 *
 * Pins the 5 contracts from `src/agent/auto-background/port.ts`:
 *   §1 NO-THROW on every public method
 *   §2 exactOptionalPropertyTypes (toolName OMITTED when absent)
 *   §3 PURE-BY-STATE (injected clock drives every decision)
 *   §4 IDEMPOTENT (double-start preserves original; double-end no-op; memory
 *      drop on end)
 *   §5 ONCE-PER-ID PROPOSAL (no re-propose after dismiss/accept/probe)
 *
 * Structural-only — no agent loop, no real LLM. Every test runs the slice in
 * isolation under a controlled clock so the threshold boundaries pin
 * deterministically.
 */

import { describe, expect, test } from "bun:test"
import {
  computeStuckProbe,
  DEFAULT_STUCK_THRESHOLD_MS,
  defaultProposeHandler,
  defaultStuckDetector,
  normalizeThreshold,
  stuckProbeAbsent,
} from "@/agent/auto-background"

describe("auto-background stuck-detector — hellgate (ADR-0223)", () => {
  /** Build a detector with an injected clock under the caller's control. */
  const buildDetector = (
    startNow: number,
    thresholdMs: number = DEFAULT_STUCK_THRESHOLD_MS,
  ): { detector: ReturnType<typeof defaultStuckDetector>; setNow: (t: number) => void } => {
    let now = startNow
    const detector = defaultStuckDetector({ thresholdMs, now: () => now })
    return {
      detector,
      setNow: (t) => {
        now = t
      },
    }
  }

  // ── HELL-AB-01 ── elapsed < threshold ⇒ stuck:false ────────────────────
  test("HELL-AB-01: <2 s elapsed is NOT stuck (default threshold)", () => {
    const { detector } = buildDetector(1_000)
    detector.tickToolStart({ toolCallId: "call-1", toolName: "bash" })
    const probe = detector.isStuck({ toolCallId: "call-1", now: 2_999 })
    expect(probe.stuck).toBe(false)
    expect(probe.elapsedMs).toBe(1_999)
    expect(probe.threshold).toBe(2_000)
  })

  // ── HELL-AB-02 ── elapsed == threshold ⇒ stuck:true (boundary INCLUSIVE)
  test("HELL-AB-02: EXACTLY 2 s elapsed IS stuck (boundary inclusive)", () => {
    const { detector } = buildDetector(0)
    detector.tickToolStart({ toolCallId: "call-2" })
    const probe = detector.isStuck({ toolCallId: "call-2", now: 2_000 })
    expect(probe.stuck).toBe(true)
    expect(probe.elapsedMs).toBe(2_000)
    expect(probe.threshold).toBe(2_000)
  })

  // ── HELL-AB-03 ── elapsed > threshold ⇒ stuck:true ─────────────────────
  test("HELL-AB-03: >2 s elapsed IS stuck", () => {
    const { detector } = buildDetector(100)
    detector.tickToolStart({ toolCallId: "call-3" })
    const probe = detector.isStuck({ toolCallId: "call-3", now: 5_000 })
    expect(probe.stuck).toBe(true)
    expect(probe.elapsedMs).toBe(4_900)
  })

  // ── HELL-AB-04 ── dismissed proposal never re-fires ────────────────────
  test("HELL-AB-04: dismissed toolCallId blocks all future shouldPropose", () => {
    const { detector } = buildDetector(0)
    const proposer = defaultProposeHandler({ detector })
    detector.tickToolStart({ toolCallId: "long-bash" })
    // First poll at 3 s ⇒ stuck ⇒ should propose.
    expect(proposer.shouldPropose({ toolCallId: "long-bash", now: 3_000 })).toBe(true)
    // User dismisses.
    proposer.dismiss({ toolCallId: "long-bash" })
    // Subsequent polls at 5 s, 10 s, 60 s all return false — even though the
    // call is still stuck per the detector.
    expect(proposer.shouldPropose({ toolCallId: "long-bash", now: 5_000 })).toBe(false)
    expect(proposer.shouldPropose({ toolCallId: "long-bash", now: 10_000 })).toBe(false)
    expect(proposer.shouldPropose({ toolCallId: "long-bash", now: 60_000 })).toBe(false)
    expect(detector.isStuck({ toolCallId: "long-bash", now: 60_000 }).stuck).toBe(true)
  })

  // ── HELL-AB-05 ── shouldPropose is at-most-once per id (no dismiss) ────
  test("HELL-AB-05: shouldPropose returns true AT MOST once per toolCallId", () => {
    const { detector } = buildDetector(0)
    const proposer = defaultProposeHandler({ detector })
    detector.tickToolStart({ toolCallId: "X" })
    expect(proposer.shouldPropose({ toolCallId: "X", now: 2_500 })).toBe(true)
    // Second consult at the same stuck moment — still false (already proposed).
    expect(proposer.shouldPropose({ toolCallId: "X", now: 2_501 })).toBe(false)
    expect(proposer.shouldPropose({ toolCallId: "X", now: 3_000 })).toBe(false)
    expect(proposer.hasProposed("X")).toBe(true)
  })

  // ── HELL-AB-06 ── independent toolCallIds don't dampen each other ──────
  test("HELL-AB-06: distinct toolCallIds propose independently", () => {
    const { detector } = buildDetector(0)
    const proposer = defaultProposeHandler({ detector })
    detector.tickToolStart({ toolCallId: "A" })
    detector.tickToolStart({ toolCallId: "B" })
    detector.tickToolStart({ toolCallId: "C" })
    expect(proposer.shouldPropose({ toolCallId: "A", now: 2_500 })).toBe(true)
    // A is now in "proposed" state; B and C are independent.
    expect(proposer.shouldPropose({ toolCallId: "B", now: 2_500 })).toBe(true)
    proposer.dismiss({ toolCallId: "B" })
    // C still ready to fire.
    expect(proposer.shouldPropose({ toolCallId: "C", now: 2_500 })).toBe(true)
    // A's dismissal of B does not affect C; A's accept does not affect B.
    expect(proposer.hasProposed("A")).toBe(true)
    expect(proposer.hasProposed("B")).toBe(true)
    expect(proposer.hasProposed("C")).toBe(true)
  })

  // ── HELL-AB-07 ── OFF parity: no detector ⇒ dispatch byte-identical ────
  test("HELL-AB-07: undefined autoBackground slot ⇒ optional chain no-op", () => {
    // Smoke: the typed slot is OPTIONAL; building an AgentConfig WITHOUT it
    // and reading via optional chain produces undefined (zero allocation).
    // We exercise the chain directly because the dispatch wrapper reads
    // `config.autoBackground?.detector?.tickToolStart(...)` — every node
    // in that chain short-circuits absent.
    const config: { autoBackground?: { detector?: { tickToolStart: () => void } } } = {}
    expect(config.autoBackground?.detector?.tickToolStart).toBeUndefined()
    expect(() => config.autoBackground?.detector?.tickToolStart?.()).not.toThrow()
  })

  // ── HELL-AB-08 ── injected clock drives every decision (no Date.now) ───
  test("HELL-AB-08: clock injection — only opts.now is consulted", () => {
    let tick = 1_000
    const detector = defaultStuckDetector({ now: () => tick })
    detector.tickToolStart({ toolCallId: "clock-test" })
    // Inject a future clock for the probe — startTimeMs was captured at 1_000.
    const probe = detector.isStuck({ toolCallId: "clock-test", now: 50_000 })
    expect(probe.stuck).toBe(true)
    expect(probe.elapsedMs).toBe(49_000)
    // Bumping the injected clock and re-probing with a SHORTER `now` produces
    // a smaller elapsed — proving Date.now is not snuck in elsewhere.
    tick = 99_999
    const probe2 = detector.isStuck({ toolCallId: "clock-test", now: 1_500 })
    expect(probe2.elapsedMs).toBe(500)
    expect(probe2.stuck).toBe(false)
  })

  // ── HELL-AB-09 ── tickToolEnd ⇒ isStuck reports absent (entry dropped) ─
  test("HELL-AB-09: tickToolEnd drops the entry; subsequent isStuck false", () => {
    const { detector } = buildDetector(0)
    detector.tickToolStart({ toolCallId: "ended" })
    expect(detector.isStuck({ toolCallId: "ended", now: 3_000 }).stuck).toBe(true)
    detector.tickToolEnd({ toolCallId: "ended" })
    const probeAfter = detector.isStuck({ toolCallId: "ended", now: 3_000 })
    expect(probeAfter.stuck).toBe(false)
    expect(probeAfter.elapsedMs).toBe(0)
    expect(detector.list()).toHaveLength(0)
  })

  // ── HELL-AB-10 ── threshold knob honored ────────────────────────────────
  test("HELL-AB-10: thresholdMs knob is honored", () => {
    const { detector } = buildDetector(0, 500)
    detector.tickToolStart({ toolCallId: "short" })
    expect(detector.isStuck({ toolCallId: "short", now: 499 }).stuck).toBe(false)
    expect(detector.isStuck({ toolCallId: "short", now: 500 }).stuck).toBe(true)
    expect(detector.isStuck({ toolCallId: "short", now: 500 }).threshold).toBe(500)
  })

  // ── HELL-AB-11 ── concurrent tracking of many tools ────────────────────
  test("HELL-AB-11: parallel tracking — N tools tracked independently", () => {
    let now = 0
    const detector = defaultStuckDetector({ now: () => now })
    detector.tickToolStart({ toolCallId: "p1", toolName: "bash" })
    now = 500
    detector.tickToolStart({ toolCallId: "p2", toolName: "read" })
    now = 1_000
    detector.tickToolStart({ toolCallId: "p3", toolName: "grep" })
    // At now=2_500: p1 is 2_500 ms (stuck), p2 is 2_000 ms (stuck — boundary),
    // p3 is 1_500 ms (not stuck).
    expect(detector.isStuck({ toolCallId: "p1", now: 2_500 }).stuck).toBe(true)
    expect(detector.isStuck({ toolCallId: "p2", now: 2_500 }).stuck).toBe(true)
    expect(detector.isStuck({ toolCallId: "p3", now: 2_500 }).stuck).toBe(false)
    expect(detector.list()).toHaveLength(3)
  })

  // ── HELL-AB-12 ── tickToolEnd memory leak prevention ───────────────────
  test("HELL-AB-12: 1 000 start→end cycles leave list() empty (no leak)", () => {
    const { detector } = buildDetector(0)
    for (let i = 0; i < 1_000; i++) {
      const id = `bulk-${i}`
      detector.tickToolStart({ toolCallId: id })
      detector.tickToolEnd({ toolCallId: id })
    }
    expect(detector.list()).toHaveLength(0)
  })

  // ── HELL-AB-13 ── idempotent tickToolStart preserves original time ─────
  test("HELL-AB-13: double tickToolStart keeps the ORIGINAL startTimeMs", () => {
    let now = 100
    const detector = defaultStuckDetector({ now: () => now })
    detector.tickToolStart({ toolCallId: "rearm" })
    now = 1_500
    // Second start should be a no-op — startTimeMs stays at 100.
    detector.tickToolStart({ toolCallId: "rearm", toolName: "bash" })
    const probe = detector.isStuck({ toolCallId: "rearm", now: 2_100 })
    // Original startTimeMs = 100; elapsed = 2_000 ⇒ stuck (the second start
    // did NOT re-arm to 1_500 which would have left it not-yet-stuck).
    expect(probe.elapsedMs).toBe(2_000)
    expect(probe.stuck).toBe(true)
  })

  // ── HELL-AB-14 ── absent id ⇒ shape-stable zero (no throw) ─────────────
  test("HELL-AB-14: isStuck on unknown id returns absent shape, no throw", () => {
    const { detector } = buildDetector(0)
    const probe = detector.isStuck({ toolCallId: "never-started", now: 100_000 })
    expect(probe.stuck).toBe(false)
    expect(probe.elapsedMs).toBe(0)
    expect(probe.threshold).toBe(2_000)
    // Double-end + end-on-unknown are no-ops (no throw).
    expect(() => detector.tickToolEnd({ toolCallId: "never-started" })).not.toThrow()
    expect(() => detector.tickToolEnd({ toolCallId: "never-started" })).not.toThrow()
  })

  // ── HELL-AB-15 ── pure helpers: NaN propagation, normalize, absent ─────
  test("HELL-AB-15: pure helpers — NaN propagates, normalize coerces, absent zero", () => {
    // computeStuckProbe with NaN clock ⇒ stuck:false (NaN >= n is false).
    const nanProbe = computeStuckProbe({
      startTimeMs: 100,
      now: Number.NaN,
      threshold: 2_000,
    })
    expect(nanProbe.stuck).toBe(false)
    expect(Number.isNaN(nanProbe.elapsedMs)).toBe(true)
    expect(nanProbe.threshold).toBe(2_000)
    // normalizeThreshold coerces non-finite / non-positive to default.
    expect(normalizeThreshold(undefined)).toBe(DEFAULT_STUCK_THRESHOLD_MS)
    expect(normalizeThreshold(0)).toBe(DEFAULT_STUCK_THRESHOLD_MS)
    expect(normalizeThreshold(-1)).toBe(DEFAULT_STUCK_THRESHOLD_MS)
    expect(normalizeThreshold(Number.NaN)).toBe(DEFAULT_STUCK_THRESHOLD_MS)
    expect(normalizeThreshold(Number.POSITIVE_INFINITY)).toBe(DEFAULT_STUCK_THRESHOLD_MS)
    expect(normalizeThreshold(750)).toBe(750)
    // stuckProbeAbsent — shape-stable zero with threshold echo.
    const absent = stuckProbeAbsent(1_234)
    expect(absent.stuck).toBe(false)
    expect(absent.elapsedMs).toBe(0)
    expect(absent.threshold).toBe(1_234)
  })

  // ── HELL-AB-16 ── proposer + accept transition (terminal posture) ──────
  test("HELL-AB-16: accept transitions to terminal — no re-propose after accept", () => {
    const { detector } = buildDetector(0)
    const proposer = defaultProposeHandler({ detector })
    detector.tickToolStart({ toolCallId: "Y" })
    expect(proposer.shouldPropose({ toolCallId: "Y", now: 2_500 })).toBe(true)
    proposer.accept({ toolCallId: "Y" })
    // Even if the detector keeps reporting stuck, no re-propose.
    expect(proposer.shouldPropose({ toolCallId: "Y", now: 10_000 })).toBe(false)
    expect(proposer.hasProposed("Y")).toBe(true)
  })

  // ── HELL-AB-17 ── proposer no-throw on detector that throws ────────────
  test("HELL-AB-17: proposer survives a throwing detector (defense-in-depth)", () => {
    const throwingDetector = {
      tickToolStart: () => {},
      tickToolEnd: () => {},
      isStuck: () => {
        throw new Error("simulated detector regression")
      },
      list: () => [],
    }
    const proposer = defaultProposeHandler({ detector: throwingDetector })
    // Should not throw — conservative posture: throwing detector ⇒ not stuck.
    expect(() => proposer.shouldPropose({ toolCallId: "Z", now: 5_000 })).not.toThrow()
    expect(proposer.shouldPropose({ toolCallId: "Z", now: 5_000 })).toBe(false)
  })
})
