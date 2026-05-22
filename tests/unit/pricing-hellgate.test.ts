/**
 * G3 — cost / pricing boundaries (HELLGATE).
 *
 * Locks the pinned price table against silent drift, asserts the EXACT
 * documented cache_read posture (see note below), and stresses the numeric
 * path with degenerate / huge inputs that classically yield NaN, Infinity,
 * float-overflow, or negative cost.
 *
 * IMPORTANT — cache_read pricing (read this before "fixing" a failure):
 *   The hellgate brief asked us to assert "cache_read priced at the cache_read
 *   rate (not full input rate) — the discount is applied". The CURRENT source
 *   (`pricing.v1`, src/observability/pricing.ts) does the OPPOSITE BY DESIGN:
 *   the docstring states cacheReadTokens are billed at the **input rate** as a
 *   conservative upper bound, with per-provider cache discounts deferred to a
 *   future `pricing.vN`. There is NO cache_read discount to assert today.
 *   These tests therefore pin the ACTUAL documented behavior (input-rate) and
 *   the report flags the brief↔source premise mismatch as a finding, not a bug.
 */
import { describe, expect, test } from "bun:test"
import { costUsd, PRICING_VERSION } from "@/observability"

/* ------------------------------------------------------------------ */
/* 1. pinned table — exact $/1M, catch silent drift                    */
/* ------------------------------------------------------------------ */

describe("G3 pinned price table (exact cost at 1M in / 1M out)", () => {
  // Each entry: [model, inPerM, outPerM]. costUsd at 1M/1M = inPerM + outPerM.
  const PINNED: Array<[string, number, number]> = [
    ["gpt-4o", 2.5, 10],
    ["gpt-4o-mini", 0.15, 0.6],
    ["claude-opus-4-7", 15, 75],
    ["claude-sonnet-4-6", 3, 15],
    ["claude-haiku-4-5", 1, 5],
  ]

  for (const [model, inPerM, outPerM] of PINNED) {
    test(`${model}: 1M in + 1M out === ${inPerM} + ${outPerM}`, () => {
      expect(costUsd(model, 1_000_000, 1_000_000)).toBe(inPerM + outPerM)
    })
    test(`${model}: input-only and output-only isolate the two rates`, () => {
      expect(costUsd(model, 1_000_000, 0)).toBe(inPerM)
      expect(costUsd(model, 0, 1_000_000)).toBe(outPerM)
    })
  }

  test("PRICING_VERSION is the pinned table key", () => {
    expect(PRICING_VERSION).toBe("pricing.v1")
  })
})

/* ------------------------------------------------------------------ */
/* 2. cache_read posture (documented: input rate, NO discount)         */
/* ------------------------------------------------------------------ */

describe("G3 cache_read pricing (pricing.v1: billed at INPUT rate — no discount)", () => {
  test("cacheReadTokens add cost at the INPUT rate, not a discounted rate", () => {
    // gpt-4o input $2.5/1M. 1M cacheRead therefore adds exactly 2.5 — the SAME
    // as 1M of fresh input. If a discount were applied this would be < 2.5.
    const base = costUsd("gpt-4o", 1_000_000, 1_000_000) as number // 12.5
    const withCache = costUsd("gpt-4o", 1_000_000, 1_000_000, 1_000_000) as number
    expect(withCache).toBe(15) // 12.5 + 2.5  (full input rate)
    expect(withCache - base).toBe(2.5) // the cache delta == the input rate
    // Equivalence: a cache_read token costs the same as an input token here.
    expect(costUsd("gpt-4o", 2_000_000, 0)).toBe(costUsd("gpt-4o", 1_000_000, 0, 1_000_000))
  })

  test("omitting cacheReadTokens equals passing 0 (default-arg parity)", () => {
    expect(costUsd("claude-opus-4-7", 1234, 5678)).toBe(
      costUsd("claude-opus-4-7", 1234, 5678, 0),
    )
  })
})

/* ------------------------------------------------------------------ */
/* 3. unknown / degenerate model → typed fallback, never NaN/crash     */
/* ------------------------------------------------------------------ */

describe("G3 unknown / degenerate model → null fallback (not NaN, not throw)", () => {
  test("unknown model → null", () => {
    expect(costUsd("totally-made-up", 100, 100)).toBeNull()
  })

  test("empty-string model → null (not a crash)", () => {
    expect(costUsd("", 100, 100)).toBeNull()
  })

  test("case-sensitive: a near-miss casing is unknown → null", () => {
    // The table key is exact; 'GPT-4O' is not 'gpt-4o'.
    expect(costUsd("GPT-4O", 100, 100)).toBeNull()
  })

  // REGRESSION: prototype-named models must hit the unknown-model contract.
  //
  // `costUsd` looks up an untrusted external `model` string. The hellgate run
  // originally caught a silent-NaN bug: a plain-object `TABLE` resolved
  // `TABLE["constructor"]` / `["toString"]` / `["__proto__"]` etc. to INHERITED
  // Object.prototype members (not undefined), the `=== undefined` guard missed,
  // and `price.inPerM` was undefined → NaN, violating "Unknown model ⇒ null".
  //
  // Fixed structurally: TABLE is now a null-prototype object (no inherited
  // members) plus an explicit `Object.hasOwn` guard at the call site. These
  // keys must therefore return `null`, exactly like any other unknown model.
  const PROTO_KEYS = ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"]
  for (const key of PROTO_KEYS) {
    test(`prototype-key "${key}" → null (unknown model, never NaN)`, () => {
      const r = costUsd(key, 1000, 1000)
      expect(r).toBeNull()
    })
  }

  test("known model + zero tokens → 0 (not null, not NaN)", () => {
    const r = costUsd("gpt-4o", 0, 0)
    expect(r).toBe(0)
    expect(Number.isNaN(r as number)).toBe(false)
  })
})

/* ------------------------------------------------------------------ */
/* 4. huge token counts — no float overflow / wrong cost               */
/* ------------------------------------------------------------------ */

describe("G3 huge token counts stay finite + correct", () => {
  test("1e12 (trillion) input tokens → finite, exact multiple of the rate", () => {
    // 1e12 input @ $2.5/1M = 2.5e12 / 1e6 = 2_500_000 USD.
    const r = costUsd("gpt-4o", 1_000_000_000_000, 0) as number
    expect(Number.isFinite(r)).toBe(true)
    expect(r).toBe(2_500_000)
  })

  test("near MAX_SAFE_INTEGER tokens → finite (no Infinity), monotonic", () => {
    const big = Number.MAX_SAFE_INTEGER // 9_007_199_254_740_991
    const r = costUsd("claude-opus-4-7", big, big) as number
    expect(Number.isFinite(r)).toBe(true)
    expect(Number.isNaN(r)).toBe(false)
    expect(r).toBeGreaterThan(0)
    // Monotonic: doubling output never lowers the cost.
    const r2 = costUsd("claude-opus-4-7", big, big * 2) as number
    expect(r2).toBeGreaterThanOrEqual(r)
  })

  test("huge cacheRead does not overflow and is added at input rate", () => {
    const r = costUsd("gpt-4o", 0, 0, 1_000_000_000_000) as number
    expect(Number.isFinite(r)).toBe(true)
    expect(r).toBe(2_500_000) // 1e12 cacheRead @ input rate, same as input
  })

  test("Infinity / NaN token inputs do not silently produce a bogus finite cost", () => {
    // These are programmer-error inputs; the contract we assert is that the
    // result is NOT a misleading finite number for a KNOWN model. With IEEE-754
    // arithmetic, Infinity*rate = Infinity and NaN*rate = NaN — both are
    // non-finite, so a downstream check can detect them rather than trusting a
    // wrong dollar figure.
    expect(Number.isFinite(costUsd("gpt-4o", Number.POSITIVE_INFINITY, 0) as number)).toBe(false)
    expect(Number.isNaN(costUsd("gpt-4o", Number.NaN, 0) as number)).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/* 5. ordering / monotonicity invariants                               */
/* ------------------------------------------------------------------ */

describe("G3 cost ordering invariants", () => {
  test("output tokens are at least as expensive as the same input tokens (every model)", () => {
    for (const m of [
      "gpt-4o",
      "gpt-4o-mini",
      "claude-opus-4-7",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ]) {
      const inOnly = costUsd(m, 500_000, 0) as number
      const outOnly = costUsd(m, 0, 500_000) as number
      expect(outOnly).toBeGreaterThanOrEqual(inOnly)
    }
  })

  test("cost is strictly increasing in each token axis for opus", () => {
    const a = costUsd("claude-opus-4-7", 1000, 1000) as number
    const b = costUsd("claude-opus-4-7", 2000, 1000) as number
    const c = costUsd("claude-opus-4-7", 2000, 2000) as number
    expect(b).toBeGreaterThan(a)
    expect(c).toBeGreaterThan(b)
  })
})
