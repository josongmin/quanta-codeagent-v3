/**
 * ★ CONTRACT — D6: src/agent/compaction-breaker.ts CompactionBreaker. The
 *   3-strike consecutive-reactive-compaction boundary is EXACT off-by-one
 *   (2 allowed, 3rd trips with reason `rapid_refill_breaker`). The 15%
 *   progress-ratio threshold is INCLUSIVE on the documented side (use
 *   exported `DEFAULT_COMPACTION_BREAKER_CAPS`, no magic literals). Trip
 *   surfaces as a clean structured abort (not infinite spin, not maxTurns
 *   exhaustion). Healthy compaction (≥15% progress) resets the strike.
 */
import { describe, expect, test } from "bun:test"
import { CompactionBreaker, DEFAULT_COMPACTION_BREAKER_CAPS } from "@/agent/compaction-breaker"

/**
 * D6 HELLGATE — the thrash breaker's EXACT boundaries.
 *
 * The breaker exists so an un-shrinkable prompt cannot spin the loop forever.
 * We pin (a) the 3-strike off-by-one and (b) the progress-ratio threshold from
 * both sides, using the ACTUAL exported constants — never a hardcoded literal,
 * so a future constant change is forced to update the contract here too.
 */

const { maxConsecutiveReactive: REACTIVE_CAP, minProgressRatio: RATIO } =
  DEFAULT_COMPACTION_BREAKER_CAPS

describe("D6 hellgate — reactive 3-strike off-by-one boundary", () => {
  test(`exactly ${REACTIVE_CAP - 1} no-progress reactive compactions are ALLOWED; the ${REACTIVE_CAP}th trips`, () => {
    const b = new CompactionBreaker()
    // Strikes 1..(CAP-1): each a no-progress compaction; the breaker must stay
    // closed BEFORE the cap is reached.
    for (let i = 1; i <= REACTIVE_CAP - 1; i++) {
      b.recordReactive(100_000, 99_000) // <15% drop ⇒ a strike
      expect(b.strikes.reactive).toBe(i)
      expect(b.check()).toEqual({ abort: false })
    }
    // The CAP-th strike trips it — and not one earlier.
    b.recordReactive(100_000, 99_000)
    expect(b.strikes.reactive).toBe(REACTIVE_CAP)
    const v = b.check()
    expect(v.abort).toBe(true)
    if (v.abort) {
      expect(v.reason).toContain("rapid_refill_breaker")
      expect(v.reason.toLowerCase()).toContain("reactive")
    }
  })

  test("a single progress run BEFORE the cap resets the count (no trip)", () => {
    const b = new CompactionBreaker()
    // Take CAP-1 strikes, then a productive compaction resets, then CAP-1 more:
    // never reaches the cap because the slate was cleared.
    for (let i = 0; i < REACTIVE_CAP - 1; i++) b.recordReactive(100_000, 99_000)
    b.recordReactive(100_000, 10_000) // 90% drop ⇒ resets
    expect(b.strikes.reactive).toBe(0)
    for (let i = 0; i < REACTIVE_CAP - 1; i++) b.recordReactive(100_000, 99_000)
    expect(b.check()).toEqual({ abort: false })
  })
})

describe("D6 hellgate — progress-ratio threshold from both sides", () => {
  // The contract: a compaction counts as PROGRESS iff (before-after)/before >=
  // minProgressRatio. So "just above the ratio" resets; "just below" is a
  // strike. We build before/after pairs straddling the exact threshold.
  const before = 1_000_000

  test(`a drop JUST ABOVE ${RATIO} does NOT count as a strike (resets)`, () => {
    const b = new CompactionBreaker()
    // First take a strike so we can observe a reset.
    b.recordReactive(100_000, 99_000)
    expect(b.strikes.reactive).toBe(1)
    // Drop ratio strictly above the threshold ⇒ progress ⇒ reset.
    const after = Math.floor(before * (1 - (RATIO + 0.01)))
    expect((before - after) / before).toBeGreaterThan(RATIO)
    b.recordReactive(before, after)
    expect(b.strikes.reactive).toBe(0)
  })

  test(`a drop JUST BELOW ${RATIO} DOES count as a strike`, () => {
    const b = new CompactionBreaker()
    const after = Math.ceil(before * (1 - (RATIO - 0.01)))
    expect((before - after) / before).toBeLessThan(RATIO)
    b.recordReactive(before, after)
    expect(b.strikes.reactive).toBe(1)
  })

  test(`a drop EXACTLY AT ${RATIO} counts as progress (>= is inclusive)`, () => {
    const b = new CompactionBreaker()
    b.recordReactive(100_000, 99_000) // seed one strike
    expect(b.strikes.reactive).toBe(1)
    const after = before - Math.round(before * RATIO) // exactly RATIO drop
    expect((before - after) / before).toBeCloseTo(RATIO, 10)
    b.recordReactive(before, after)
    // Inclusive `>=` ⇒ exactly-at-threshold is progress ⇒ resets.
    expect(b.strikes.reactive).toBe(0)
  })
})

describe("D6 hellgate — proactive boundary mirrors reactive", () => {
  const PROACTIVE_CAP = DEFAULT_COMPACTION_BREAKER_CAPS.maxNoProgressProactive
  test(`the ${PROACTIVE_CAP}th no-progress proactive compaction trips the circuit breaker`, () => {
    const b = new CompactionBreaker()
    for (let i = 1; i <= PROACTIVE_CAP - 1; i++) {
      b.recordProactive(200_000, 199_000)
      expect(b.check()).toEqual({ abort: false })
    }
    b.recordProactive(200_000, 199_000)
    const v = b.check()
    expect(v.abort).toBe(true)
    if (v.abort) {
      expect(v.reason).toContain("rapid_refill_breaker")
      expect(v.reason).toContain("circuit")
    }
  })
})

describe("D6 hellgate — trip surfaces a CLEAN error verdict (not a spin)", () => {
  test("a tripped breaker returns a structured abort verdict with a human reason, deterministically", () => {
    const b = new CompactionBreaker({ maxConsecutiveReactive: 1 })
    b.recordReactive(100_000, 99_999) // ~0% drop ⇒ instant strike at cap=1
    const v = b.check()
    expect(v.abort).toBe(true)
    if (v.abort) {
      // A non-empty, actionable string — surfaces as the loop error reason,
      // NOT a thrown exception, NOT undefined, NOT maxTurns exhaustion.
      expect(typeof v.reason).toBe("string")
      expect(v.reason.length).toBeGreaterThan(20)
      expect(v.reason).toContain("rapid_refill_breaker")
    }
    // Idempotent: checking again does not change the verdict (no hidden state
    // drift that could spin). Stays tripped.
    expect(b.check().abort).toBe(true)
  })

  test("a degenerate before<=0 compaction never trips (cannot spin on a no-op)", () => {
    const b = new CompactionBreaker({ maxConsecutiveReactive: 1 })
    for (let i = 0; i < 5; i++) b.recordReactive(0, 0)
    expect(b.strikes.reactive).toBe(0)
    expect(b.check()).toEqual({ abort: false })
  })
})
