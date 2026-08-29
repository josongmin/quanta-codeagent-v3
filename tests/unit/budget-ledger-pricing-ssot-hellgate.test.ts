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

  test("ledger cacheRead follows the PROVIDER's convention, and matches the SSOT total", () => {
    // MR-05 — this test used to assert the additive computation for BOTH
    // models. Additive is right for Anthropic, whose `input_tokens` excludes
    // cache reads. It is wrong for OpenAI, whose `prompt_tokens` already
    // contains them, so the old expectation pinned a double-bill: one gpt-5.4
    // call cost $2.60 here and $1.60 on the path the budget meter read, inside
    // a single `emitUsage`.
    //
    // The assertion is now stronger than the one it replaces: the ledger total
    // must equal the SSOT total for every model, cache reads included. That
    // makes agreement the property under test instead of one formula's shape.
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
      expect(DEFAULT_MODEL_PRICING[model]?.cacheReadPerM).toBeGreaterThan(0)
      expect(cost).toBeCloseTo(costUsd(model, 1_000_000, 0, 400_000) ?? -1, 6)
    }
    // Pin the two conventions explicitly, so a regression that flattens them
    // back to one formula fails by name rather than by a drifting total.
    const openai = defaultBudgetLedger()
    expect(
      openai.record({
        model: "gpt-5.4",
        sessionId: "s",
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 400_000,
        at: 0,
      }).cost,
    ).toBeCloseTo(1.6, 6) // 600k fresh @ $2.50 + 400k cached @ $0.25
    const anthropic = defaultBudgetLedger()
    expect(
      anthropic.record({
        model: "claude-sonnet-4-6",
        sessionId: "s",
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 400_000,
        at: 0,
      }).cost,
    ).toBeCloseTo(3.12, 6) // 1M fresh @ $3 + 400k cached @ $0.30
  })
})
