/**
 * jul-03 B3 hellgate — BudgetMeter provider rate-limit tap (SEPARATE from cost).
 *
 * The memory write-guard's `remainingPercent()` today reads the LOCAL cost/token
 * fraction, which returns 100 when NO consumable dial is configured (a human
 * REPL). That mirrors Codex `min_rate_limit_remaining_percent` by NAME only —
 * there is no real provider signal behind it.
 *
 * This adds a REAL provider `x-ratelimit-remaining` percentage tap to the meter:
 *   - a SEPARATE field from the cost dials (never derived from cost fractions);
 *   - returns `undefined` when never observed (distinct from cost's 100 default);
 *   - the observed percent is clamped to [0,100]; garbage ⇒ no-op (never poisons).
 *
 * Pure/leaf — no I/O, no clock. Punchcard-compliant.
 */

import { describe, expect, test } from "bun:test"
import { BudgetMeter } from "@/agent"

describe("BudgetMeter provider rate-limit tap", () => {
  test("never observed ⇒ undefined (NOT the cost meter's 100 default)", () => {
    const m = new BudgetMeter()
    expect(m.providerRateLimitRemainingPercent()).toBeUndefined()
    // Contrast: the LOCAL cost fraction reads 100 with no dial (the fake signal).
    expect(m.remainingPercent()).toBe(100)
  })

  test("observed percent is readable and SEPARATE from cost", () => {
    const m = new BudgetMeter({ dials: { maxTotalTokens: 1000 } })
    m.tick("input_tokens", 100) // local cost = 90% remaining
    m.observeProviderRateLimitRemainingPercent(12)
    // Provider window is nearly exhausted; local cost is fine. They diverge.
    expect(m.providerRateLimitRemainingPercent()).toBe(12)
    expect(m.remainingPercent()).toBeCloseTo(90, 5)
  })

  test("last-write-wins on repeated observation", () => {
    const m = new BudgetMeter()
    m.observeProviderRateLimitRemainingPercent(80)
    m.observeProviderRateLimitRemainingPercent(30)
    expect(m.providerRateLimitRemainingPercent()).toBe(30)
  })

  test("garbage observation ⇒ no-op (never poisons the tap)", () => {
    const m = new BudgetMeter()
    m.observeProviderRateLimitRemainingPercent(50)
    m.observeProviderRateLimitRemainingPercent(Number.NaN)
    m.observeProviderRateLimitRemainingPercent(-5)
    m.observeProviderRateLimitRemainingPercent(150)
    // Only the first well-formed value survives; garbage is ignored.
    expect(m.providerRateLimitRemainingPercent()).toBe(50)
  })

  test("clamps a boundary value into [0,100]", () => {
    const m = new BudgetMeter()
    m.observeProviderRateLimitRemainingPercent(0)
    expect(m.providerRateLimitRemainingPercent()).toBe(0)
    m.observeProviderRateLimitRemainingPercent(100)
    expect(m.providerRateLimitRemainingPercent()).toBe(100)
  })

  test("does not alter the cost snapshot or checkExhausted (byte-identical)", () => {
    const m = new BudgetMeter({ dials: { maxTotalTokens: 10 } })
    m.observeProviderRateLimitRemainingPercent(1)
    // Provider tap must not leak into the cost snapshot or the hard gate.
    expect(m.snapshot().inputTokens).toBe(0)
    expect(m.checkExhausted().exhausted).toBe(false)
  })
})
