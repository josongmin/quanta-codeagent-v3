/**
 * Replay verdict ladder — exercises the REAL `verdictFromDiff` (replay.ts), not
 * a re-derived ratio. Pins:
 *
 *   - matched → pass
 *   - ≤10% divergence → partial   (boundary is INCLUSIVE)
 *   - >10% divergence → fail
 *   - zero-length original never divides by zero (max(1, n) guard)
 *
 * The threshold constant `REPLAY_PARTIAL_RATIO` is pinned separately so a silent
 * bump of the ratio is also caught.
 */
import { describe, expect, test } from "bun:test"
import type { DiffSummary } from "@/../src/apps/eval/trajectory/diff"
import { REPLAY_PARTIAL_RATIO, verdictFromDiff } from "@/../src/apps/eval/trajectory/replay"

const diff = (over: Partial<DiffSummary>): DiffSummary => ({
  matched: false,
  divergedEvents: 0,
  originalLength: 0,
  replayLength: 0,
  firstDivergences: [],
  ...over,
})

describe("replay verdict threshold", () => {
  test("REPLAY_PARTIAL_RATIO is 0.1 (10%)", () => {
    expect(REPLAY_PARTIAL_RATIO).toBe(0.1)
  })

  test("matched diff → pass", () => {
    expect(verdictFromDiff(diff({ matched: true, originalLength: 50 }))).toBe("pass")
  })

  test("3 diverged out of 50 → ratio 0.06 ≤ 0.1 → partial", () => {
    expect(verdictFromDiff(diff({ divergedEvents: 3, originalLength: 50 }))).toBe("partial")
  })

  test("3 diverged out of 10 → ratio 0.30 > 0.1 → fail", () => {
    expect(verdictFromDiff(diff({ divergedEvents: 3, originalLength: 10 }))).toBe("fail")
  })

  test("boundary: 1 diverged out of 10 → ratio exactly 0.1 → partial (inclusive)", () => {
    expect(verdictFromDiff(diff({ divergedEvents: 1, originalLength: 10 }))).toBe("partial")
  })

  test("just over boundary: 2 diverged out of 10 → 0.2 → fail", () => {
    expect(verdictFromDiff(diff({ divergedEvents: 2, originalLength: 10 }))).toBe("fail")
  })

  test("zero-length original, no divergence → partial (no divide-by-zero)", () => {
    const v = verdictFromDiff(diff({ divergedEvents: 0, originalLength: 0 }))
    expect(v).toBe("partial")
  })

  test("zero-length original WITH divergence → fail via max(1, n) guard (not Infinity/NaN)", () => {
    expect(verdictFromDiff(diff({ divergedEvents: 5, originalLength: 0 }))).toBe("fail")
  })
})
