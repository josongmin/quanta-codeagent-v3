/**
 * Strategy tool #8 — effort ladder. Hard scenarios:
 *  - tier 0 ≡ DEFAULT exactly (byte-identical invariant)
 *  - monotonic, linear escalation derived FROM DEFAULT (red-on-injection: if the
 *    base ladder changes, the tiers track it)
 *  - tier clamp to [0, MAX] (no runaway)
 *  - env parse: off / "0" / negative / non-integer / blank ⇒ undefined; positive ⇒ tier
 */

import { describe, expect, test } from "bun:test"
import {
  effortLadderLimits,
  MAX_EFFORT_TIER,
  resolveEffortLadderLimits,
} from "../../src/runner/batch/eval/adaptive-escalation/effort-ladder"
import { DEFAULT_ADAPTIVE_LIMITS } from "../../src/runner/batch/eval/adaptive-escalation/transitions"

describe("effortLadderLimits", () => {
  test("tier 0 ≡ DEFAULT exactly (byte-identical invariant)", () => {
    expect(effortLadderLimits(0)).toEqual(DEFAULT_ADAPTIVE_LIMITS)
  })

  test("each tier adds headroom, derived FROM the base (linear)", () => {
    const t1 = effortLadderLimits(1)
    expect(t1.maxTotalSteps).toBe(DEFAULT_ADAPTIVE_LIMITS.maxTotalSteps + 2)
    expect(t1.maxExpensive).toBe(DEFAULT_ADAPTIVE_LIMITS.maxExpensive + 1)
    expect(t1.maxPerAction).toBe(DEFAULT_ADAPTIVE_LIMITS.maxPerAction + 1)
    const t2 = effortLadderLimits(2)
    expect(t2.maxTotalSteps).toBe(DEFAULT_ADAPTIVE_LIMITS.maxTotalSteps + 4)
    expect(t2.maxExpensive).toBe(DEFAULT_ADAPTIVE_LIMITS.maxExpensive + 2)
  })

  test("monotonic non-decreasing across tiers", () => {
    let prev = effortLadderLimits(0)
    for (let t = 1; t <= MAX_EFFORT_TIER + 2; t++) {
      const cur = effortLadderLimits(t)
      expect(cur.maxTotalSteps).toBeGreaterThanOrEqual(prev.maxTotalSteps)
      expect(cur.maxExpensive).toBeGreaterThanOrEqual(prev.maxExpensive)
      prev = cur
    }
  })

  test("tier is clamped to [0, MAX_EFFORT_TIER] (no runaway)", () => {
    expect(effortLadderLimits(999)).toEqual(effortLadderLimits(MAX_EFFORT_TIER))
    expect(effortLadderLimits(-5)).toEqual(DEFAULT_ADAPTIVE_LIMITS)
    expect(effortLadderLimits(1.9).maxExpensive).toBe(effortLadderLimits(1).maxExpensive) // floored
  })

  test("derives from a provided base (red-on-injection — tracks base changes)", () => {
    const base = { maxTotalSteps: 10, maxExpensive: 5, maxPerAction: 5 }
    expect(effortLadderLimits(1, base)).toEqual({
      maxTotalSteps: 12,
      maxExpensive: 6,
      maxPerAction: 6,
    })
  })
})

describe("resolveEffortLadderLimits — env parse", () => {
  test("off / 0 / negative / non-integer / blank ⇒ undefined (DEFAULT ⇒ byte-identical)", () => {
    expect(resolveEffortLadderLimits({})).toBeUndefined()
    expect(resolveEffortLadderLimits({ QUANTA_BENCH_EFFORT_LADDER: "0" })).toBeUndefined()
    expect(resolveEffortLadderLimits({ QUANTA_BENCH_EFFORT_LADDER: "-2" })).toBeUndefined()
    expect(resolveEffortLadderLimits({ QUANTA_BENCH_EFFORT_LADDER: "2.5" })).toBeUndefined()
    expect(resolveEffortLadderLimits({ QUANTA_BENCH_EFFORT_LADDER: "high" })).toBeUndefined()
    expect(resolveEffortLadderLimits({ QUANTA_BENCH_EFFORT_LADDER: "  " })).toBeUndefined()
  })

  test("positive integer ⇒ that tier's limits", () => {
    expect(resolveEffortLadderLimits({ QUANTA_BENCH_EFFORT_LADDER: "1" })).toEqual(
      effortLadderLimits(1),
    )
    expect(resolveEffortLadderLimits({ QUANTA_BENCH_EFFORT_LADDER: " 2 " })).toEqual(
      effortLadderLimits(2),
    )
  })
})
