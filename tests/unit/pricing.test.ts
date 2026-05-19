import { describe, expect, test } from "bun:test"
import { costUsd, PRICING_VERSION } from "@/observability"

describe("PRICING_VERSION", () => {
  test("is the versioned price-table key", () => {
    expect(PRICING_VERSION).toBe("pricing.v1")
  })
})

describe("costUsd", () => {
  test("known model returns a positive hand-computed value", () => {
    // gpt-4o public list price: $2.50 / 1M input, $10.00 / 1M output.
    // 1,000,000 in + 1,000,000 out = 2.50 + 10.00 = 12.50
    expect(costUsd("gpt-4o", 1_000_000, 1_000_000)).toBe(12.5)
  })

  test("gpt-4o-mini hand-computed value", () => {
    // $0.15 / 1M input, $0.60 / 1M output → 0.15 + 0.60 = 0.75
    expect(costUsd("gpt-4o-mini", 1_000_000, 1_000_000)).toBe(0.75)
  })

  test("claude-opus-4-7 hand-computed value", () => {
    // $15 / 1M input, $75 / 1M output → 15 + 75 = 90
    expect(costUsd("claude-opus-4-7", 1_000_000, 1_000_000)).toBe(90)
  })

  test("claude-sonnet-4-6 hand-computed value", () => {
    // $3 / 1M input, $15 / 1M output → 3 + 15 = 18
    expect(costUsd("claude-sonnet-4-6", 1_000_000, 1_000_000)).toBe(18)
  })

  test("claude-haiku-4-5 hand-computed value", () => {
    // $1 / 1M input, $5 / 1M output → 1 + 5 = 6
    expect(costUsd("claude-haiku-4-5", 1_000_000, 1_000_000)).toBe(6)
  })

  test("fractional token count is exact", () => {
    // gpt-4o: 500 in @ $2.5/1M + 250 out @ $10/1M
    // = 500 * 2.5e-6 + 250 * 1e-5 = 0.00125 + 0.0025 = 0.00375
    expect(costUsd("gpt-4o", 500, 250)).toBeCloseTo(0.00375, 12)
  })

  test("unknown model returns null (not an error)", () => {
    expect(costUsd("totally-made-up-model", 100, 100)).toBeNull()
  })

  test("zero tokens for a known model returns 0 (not null)", () => {
    expect(costUsd("gpt-4o", 0, 0)).toBe(0)
  })

  test("cacheReadTokens billed at the input rate (documented choice)", () => {
    // gpt-4o input $2.5/1M; 1M cacheRead adds 2.5 on top of 12.5 = 15
    expect(costUsd("gpt-4o", 1_000_000, 1_000_000, 1_000_000)).toBe(15)
  })

  test("omitting cacheReadTokens equals passing zero", () => {
    expect(costUsd("gpt-4o", 1000, 1000)).toBe(costUsd("gpt-4o", 1000, 1000, 0))
  })

  test("monotonic: more tokens never decreases cost", () => {
    const a = costUsd("claude-sonnet-4-6", 100, 100)
    const b = costUsd("claude-sonnet-4-6", 200, 100)
    const c = costUsd("claude-sonnet-4-6", 200, 300)
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(c).not.toBeNull()
    expect(b as number).toBeGreaterThanOrEqual(a as number)
    expect(c as number).toBeGreaterThanOrEqual(b as number)
  })

  test("output tokens cost at least as much as the same input tokens", () => {
    const inOnly = costUsd("gpt-4o", 1_000_000, 0)
    const outOnly = costUsd("gpt-4o", 0, 1_000_000)
    expect(outOnly as number).toBeGreaterThanOrEqual(inOnly as number)
  })
})
