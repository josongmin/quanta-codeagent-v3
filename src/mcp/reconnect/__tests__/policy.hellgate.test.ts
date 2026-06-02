/** ADR-0435 — backoff policy hellgate (RFC §9 cases 2, 9).
 *
 *  Proves `backoffDelay` is byte-equivalent to Cursor `Fd` and that clamp
 *  guards keep a pathological config inside [base, max]. NO real timers / RNG —
 *  `random` is always injected. */

import { describe, expect, it } from "bun:test"
import { backoffDelay, DEFAULT_BACKOFF_POLICY } from "../policy"

describe("ADR-0435 backoffDelay — Cursor Fd equivalence", () => {
  it("attempt=0 returns exactly base (no jitter), independent of random()", () => {
    // Cursor: n = min(base*2^0, max) = base ⇒ n <= base ⇒ returns base.
    expect(backoffDelay(0, 5_000, 60_000, () => 0)).toBe(5_000)
    expect(backoffDelay(0, 5_000, 60_000, () => 0.999)).toBe(5_000)
    expect(backoffDelay(0, 5_000, 60_000, () => 0.5)).toBe(5_000)
  })

  it("random()=0 yields the lower bound = base for every attempt", () => {
    // base + 0*(capped-base) === base.
    for (let a = 0; a < 6; a += 1) {
      expect(backoffDelay(a, 5_000, 60_000, () => 0)).toBe(5_000)
    }
  })

  it("random()→1 approaches the capped ceiling (full-jitter upper bound)", () => {
    // attempt=1: capped = min(5000*2, 60000) = 10000. base + ~1*(10000-5000).
    const d = backoffDelay(1, 5_000, 60_000, () => 0.999999)
    expect(d).toBeGreaterThan(9_999)
    expect(d).toBeLessThanOrEqual(10_000)
  })

  it("capped exponential clamps to max once base*2^attempt exceeds max", () => {
    // attempt=10: 5000*1024 = 5,120,000 → clamp to 60,000. random()=1 ⇒ ~60000.
    const d = backoffDelay(10, 5_000, 60_000, () => 0.999999)
    expect(d).toBeGreaterThan(59_999)
    expect(d).toBeLessThanOrEqual(60_000)
    // random()=0 ⇒ exactly base.
    expect(backoffDelay(10, 5_000, 60_000, () => 0)).toBe(5_000)
  })

  it("delay is uniform over [base, capped] for attempt>0", () => {
    // attempt=2: capped = min(5000*4, 60000) = 20000. random=0.5 ⇒ midpoint.
    expect(backoffDelay(2, 5_000, 60_000, () => 0.5)).toBe(12_500)
  })

  it("matches Cursor Fd reference for the default policy attempts 0..4", () => {
    const { fastRetryBaseMs: b, fastRetryMaxMs: m } = DEFAULT_BACKOFF_POLICY
    const fd = (attempt: number, r: number): number => {
      const n = Math.min(b * 2 ** attempt, m)
      return n <= b ? b : b + r * (n - b)
    }
    for (let a = 0; a < 5; a += 1) {
      for (const r of [0, 0.25, 0.5, 0.75]) {
        expect(backoffDelay(a, b, m, () => r)).toBe(fd(a, r))
      }
    }
  })
})

describe("ADR-0435 backoffDelay — clamp on pathological config (RFC §9.9)", () => {
  it("max < base never returns below base", () => {
    // safeMax floored to base ⇒ capped === base ⇒ returns base.
    expect(backoffDelay(3, 5_000, 1_000, () => 0.9)).toBe(5_000)
  })

  it("negative base is floored to 0, result stays non-negative", () => {
    const d = backoffDelay(2, -100, 10_000, () => 0.5)
    expect(d).toBeGreaterThanOrEqual(0)
    expect(d).toBeLessThanOrEqual(10_000)
  })

  it("result always within [base, max] across a random() sweep", () => {
    const base = 300_000
    const max = 1_800_000
    for (let a = 0; a < 8; a += 1) {
      for (let r = 0; r < 1; r += 0.1) {
        const d = backoffDelay(a, base, max, () => r)
        expect(d).toBeGreaterThanOrEqual(base)
        expect(d).toBeLessThanOrEqual(max)
      }
    }
  })
})
