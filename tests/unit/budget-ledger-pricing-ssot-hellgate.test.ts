/**
 * HELLGATE — L4a: the budget ledger's price table is the ONE pricing SSOT.
 *
 * The ledger shipped its own `DEFAULT_MODEL_PRICING` that had DRIFTED from
 * `@/observability` pricing: `gpt-5` was $10/$30 (the stale launch price; the
 * SSOT confirms $1.25/$10) and the bench's primary models `gpt-5.4`/`gpt-5.5`
 * were ABSENT — so a wired ledger would have silently billed them at the
 * sonnet fallback rate, corrupting campaign cost measurement.
 *
 * After unification the ledger derives every known-model rate from the SSOT, so
 * a ledger event for a SSOT model costs EXACTLY what `costUsd` bills (modulo the
 * ledger's extra cache-write dimension, which the SSOT does not charge).
 */
import { describe, expect, test } from "bun:test"
import { DEFAULT_MODEL_PRICING, defaultBudgetLedger } from "@/agent/budget-ledger"
import { costUsd } from "@/observability"

describe("HELLGATE L4a — ledger pricing derives from the @/observability SSOT", () => {
  test("bench primary models are PRESENT (no silent sonnet fallback)", () => {
    expect(DEFAULT_MODEL_PRICING["gpt-5.6-terra"]).toBeDefined()
    expect(DEFAULT_MODEL_PRICING["gpt-5.4"]).toBeDefined()
    expect(DEFAULT_MODEL_PRICING["gpt-5.5"]).toBeDefined()
  })

  test("gpt-5 drift is fixed: $1.25/1M in, $10/1M out (SSOT, not stale $10/$30)", () => {
    expect(DEFAULT_MODEL_PRICING["gpt-5"]?.inputPerM).toBe(1.25)
    expect(DEFAULT_MODEL_PRICING["gpt-5"]?.outputPerM).toBe(10)
  })

  test("ledger total cost == costUsd for SSOT models (input+output, no cache)", () => {
    // RecordResult.cost is the TOTAL USD (a number). With no cache tokens the
    // ledger's additive model and costUsd agree exactly (nothing to carve out).
    for (const model of [
      "gpt-5.6-terra",
      "gpt-5.4",
      "gpt-5.5",
      "claude-opus-4-7",
      "claude-haiku-4-5",
    ]) {
      const ledger = defaultBudgetLedger()
      const { cost } = ledger.record({
        model,
        sessionId: "s",
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        at: 0,
      })
      const ssot = costUsd(model, 1_000_000, 500_000) ?? -1
      expect(cost).toBeCloseTo(ssot, 6)
    }
  })

  test("ledger cacheRead is billed at the SSOT-derived rate (additive model)", () => {
    // The ledger bills input + cacheRead as SEPARATE additive buckets; the RATES
    // come from the shared SSOT card. Assert the total equals the additive
    // computation using the derived per-component rates.
    for (const model of ["gpt-5.4", "claude-sonnet-4-6"]) {
      const ledger = defaultBudgetLedger()
      const { cost } = ledger.record({
        model,
        sessionId: "s",
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 400_000,
        at: 0,
      })
      const rates = DEFAULT_MODEL_PRICING[model]
      const cacheReadRate = rates?.cacheReadPerM
      expect(cacheReadRate).toBeGreaterThan(0)
      const expected =
        (1_000_000 * (rates?.inputPerM ?? 0) + 400_000 * (cacheReadRate as number)) / 1_000_000
      expect(cost).toBeCloseTo(expected, 6)
    }
  })
})
