import { describe, expect, test } from "bun:test"
import { costUsd, PRICING_VERSION, providerOf } from "@/observability"

describe("PRICING_VERSION", () => {
  test("is the versioned price-table key", () => {
    // Bumped v1 → v2 with the provider-aware cache-read fix: the table now
    // carries per-model cacheReadPerM and OpenAI no longer double-counts cache.
    // Bumped v2 → v3 when gpt-5.6-terra gained an exact post-cut rate card.
    expect(PRICING_VERSION).toBe("pricing.v3")
  })
})

describe("providerOf", () => {
  test("gpt/o1/o3 prefixes → openai", () => {
    expect(providerOf("gpt-4o")).toBe("openai")
    expect(providerOf("gpt-4o-mini")).toBe("openai")
    expect(providerOf("o1-preview")).toBe("openai")
    expect(providerOf("o3-mini")).toBe("openai")
  })
  test("claude prefix → anthropic", () => {
    expect(providerOf("claude-opus-4-7")).toBe("anthropic")
  })
  test("unknown prefix defaults to anthropic (additive semantics)", () => {
    expect(providerOf("mystery-model")).toBe("anthropic")
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

  test("gpt-5.6-terra uses the current post-cut public rates", () => {
    // 2026-07-30 public rate: $2/M input + $12/M output.
    expect(costUsd("gpt-5.6-terra", 1_000_000, 1_000_000)).toBe(14)
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

  // ── UPDATED for the provider-aware cache-read fix (pricing.v2) ──────────
  // OLD (pricing.v1, BUGGY): cacheRead was billed at the full input rate and
  // ADDED on top of input for every provider:
  //     (input + cacheRead)*inRate + output*outRate
  //     gpt-4o 1M/1M/1M → (1M+1M)*2.5/1M + 1M*10/1M = 5 + 10 = 15  ← pinned 15
  // That double-counts OpenAI: its `prompt_tokens` ALREADY INCLUDES
  // `cached_tokens`, so the 1M cacheRead was being charged once inside the 1M
  // input AND again as a separate +2.5. The correct OpenAI bill carves the
  // cached portion OUT of input and re-prices it at the discounted cache rate:
  //     (input − cacheRead)*inRate + cacheRead*cacheRate + output*outRate
  //     = (1M−1M)*2.5/1M + 1M*1.25/1M + 1M*10/1M = 0 + 1.25 + 10 = 11.25
  test("OpenAI cacheRead is carved out of prompt_tokens, not double-counted", () => {
    // gpt-4o: in $2.5/1M, cached $1.25/1M, out $10/1M.
    expect(costUsd("gpt-4o", 1_000_000, 1_000_000, 1_000_000)).toBe(11.25)
    // No cache hit → unchanged from v1 (cacheRead 0 carves nothing): 12.5.
    expect(costUsd("gpt-4o", 1_000_000, 1_000_000, 0)).toBe(12.5)
  })

  test("Anthropic cacheRead is additive at the discounted cache-read rate", () => {
    // claude-opus-4-7: in $15/1M, cache-read $1.50/1M, out $75/1M.
    // input_tokens EXCLUDES cache reads → input stays whole, cacheRead adds at
    // the discounted rate: 1M*15 + 1M*1.5 + 1M*75 (all /1M) = 91.5
    expect(costUsd("claude-opus-4-7", 1_000_000, 1_000_000, 1_000_000)).toBe(91.5)
  })

  test("no double-count: same token counts, OpenAI cost < Anthropic-style additive", () => {
    // Hold rates equal by comparing each provider against its OWN additive
    // (v1-style) upper bound. The fix must make OpenAI cheaper than the additive
    // model when cache hits; Anthropic stays additive (its API really excludes
    // cache from input), so it is NOT reduced below its additive baseline.
    const inTok = 1_000_000
    const outTok = 500_000
    const cacheTok = 800_000

    // OpenAI (gpt-4o): correct carve-out vs the buggy additive (input+cache).
    const openaiCorrect = costUsd("gpt-4o", inTok, outTok, cacheTok) as number
    const openaiAdditiveBug = ((inTok + cacheTok) * 2.5 + outTok * 10) / 1_000_000
    expect(openaiCorrect).toBeLessThan(openaiAdditiveBug)
    // Hand-check: (1M−0.8M)*2.5 + 0.8M*1.25 + 0.5M*10 all /1M = 0.5 + 1.0 + 5 = 6.5
    expect(openaiCorrect).toBeCloseTo(6.5, 9)

    // Anthropic (claude-sonnet-4-6): cacheRead added at discounted rate ($0.30)
    // is strictly cheaper than the old input-rate ($3) treatment.
    const anthroNew = costUsd("claude-sonnet-4-6", inTok, outTok, cacheTok) as number
    const anthroV1 = ((inTok + cacheTok) * 3 + outTok * 15) / 1_000_000
    expect(anthroNew).toBeLessThan(anthroV1)
  })

  test("omitting cacheReadTokens equals passing zero", () => {
    expect(costUsd("gpt-4o", 1000, 1000)).toBe(costUsd("gpt-4o", 1000, 1000, 0))
    expect(costUsd("claude-opus-4-7", 1000, 1000)).toBe(costUsd("claude-opus-4-7", 1000, 1000, 0))
  })

  test("OpenAI cacheRead clamps to input (malformed cached > prompt → no negative)", () => {
    // cached(2M) > input(1M): clamp to 1M cached, 0 fresh → 1M*1.25 + out.
    // = 1.25 + 0 = 1.25 (no negative fresh portion).
    expect(costUsd("gpt-4o", 1_000_000, 0, 2_000_000)).toBe(1.25)
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

  test("negative clamp: negative token counts never yield negative cost (no meter divergence)", () => {
    // A negative count yields a positive FINITE cost that would slip past the
    // budget meter's `tick` guard (which no-ops n<0) while the token counters
    // drop it — diverging cost from tokens. Clamp keeps them consistent.
    // anthropic (additive): negative input collapses to 0, output still bills.
    expect(costUsd("claude-sonnet-4-6", -1000, 1000)).toBe((1000 * 15) / 1_000_000)
    // openai (carve-out): negative input → 0 in-cost, output still bills.
    expect(costUsd("gpt-4o", -5000, 1000)).toBe((1000 * 10) / 1_000_000)
    // all-negative → exactly 0, never below.
    expect(costUsd("gpt-5.4", -1, -1, -1)).toBe(0)
    // CONTRACT PRESERVED: NaN/Infinity stay NON-finite (fail-loud, detectable
    // downstream) — clamp touches negatives ONLY.
    expect(Number.isNaN(costUsd("gpt-5.4", Number.NaN, 0) as number)).toBe(true)
    expect(Number.isFinite(costUsd("gpt-5.4", Number.POSITIVE_INFINITY, 0) as number)).toBe(false)
  })
})
