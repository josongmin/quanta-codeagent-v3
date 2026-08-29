/**
 * MR-01 hellgate — the canonical normalize + price pair.
 *
 * Two properties carry the whole design:
 *
 *   1. NORMALIZATION IS WHERE PROVIDERS DIFFER. After `normalizeUsage` the
 *      buckets are disjoint for every provider, so `priceUsage` has no provider
 *      branch to get wrong. The bug being retired — one event costing $1.60 on
 *      one path and $2.60 on another — was two implementations each carrying
 *      their own copy of the provider rule.
 *   2. UNKNOWN PRICING IS FLAGGED, NOT FAKED. An unpriced model still produces
 *      a visible estimate (spend that renders as $0 is the worse failure), but
 *      `pricingKnown: false` travels with it so nothing presents or enforces
 *      against a guess as though it were measured.
 *
 * The parity census at the bottom is the wiring proof for the `costUsd`
 * compatibility wrapper: it pins that delegating to `priceUsage` reproduces the
 * shipped formula for EVERY carded model, which is what makes the swap safe.
 */
import { describe, expect, test } from "bun:test"
import { costUsd, MODEL_RATE_CARD, PRICING_VERSION } from "@/observability/pricing"
import { normalizeUsage, priceUsage, promptTokensOf } from "@/observability/usage-accounting"

const opts = { pricingVersion: PRICING_VERSION }
const round = (n: number) => Math.round(n * 1e6) / 1e6

describe("normalizeUsage — provider conventions collapse into disjoint buckets", () => {
  test("openai carves cache reads OUT of the reported prompt", () => {
    // prompt_tokens ALREADY includes cached_tokens.
    const n = normalizeUsage({
      model: "gpt-5.4",
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 400_000,
    })
    expect(n.freshInputTokens).toBe(600_000)
    expect(n.cacheReadTokens).toBe(400_000)
    expect(promptTokensOf(n)).toBe(1_000_000) // the prompt is not inflated
  })

  test("anthropic keeps cache reads ALONGSIDE the reported input", () => {
    // input_tokens EXCLUDES cache reads.
    const n = normalizeUsage({
      model: "claude-sonnet-4-6",
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 400_000,
    })
    expect(n.freshInputTokens).toBe(1_000_000)
    expect(n.cacheReadTokens).toBe(400_000)
    expect(promptTokensOf(n)).toBe(1_400_000)
  })

  test("an explicit provider beats name inference", () => {
    // A proxy alias or fine-tune whose id does not follow the vendor prefix.
    const n = normalizeUsage({
      model: "internal-lane-7",
      provider: "openai",
      inputTokens: 1_000,
      outputTokens: 0,
      cacheReadTokens: 400,
    })
    expect(n.provider).toBe("openai")
    expect(n.freshInputTokens).toBe(600) // carved out, despite the non-gpt name
  })

  test("a malformed openai event claiming more cache than prompt cannot go negative", () => {
    const n = normalizeUsage({
      model: "gpt-5.4",
      inputTokens: 100,
      outputTokens: 0,
      cacheReadTokens: 900,
    })
    expect(n.freshInputTokens).toBe(0)
    expect(n.cacheReadTokens).toBe(100) // clamped to what was actually prompted
  })

  test("negative counts clamp to 0 but non-finite counts stay visible", () => {
    const neg = normalizeUsage({
      model: "gpt-5.4",
      inputTokens: -5,
      outputTokens: -7,
      cacheReadTokens: -1,
    })
    expect(neg.freshInputTokens).toBe(0)
    expect(neg.outputTokens).toBe(0)
    // Non-finite is a BROKEN report. Rewriting it to 0 would understate a bill
    // silently; the existing pricing contract requires it to stay detectable.
    const nan = normalizeUsage({
      model: "claude-sonnet-4-6",
      inputTokens: Number.NaN,
      outputTokens: 1,
    })
    expect(Number.isNaN(nan.freshInputTokens)).toBe(true)
    const inf = normalizeUsage({
      model: "claude-sonnet-4-6",
      inputTokens: Number.POSITIVE_INFINITY,
      outputTokens: 1,
    })
    expect(inf.freshInputTokens).toBe(Number.POSITIVE_INFINITY)
  })
})

describe("priceUsage — itemized, versioned, and honest about what it knows", () => {
  test("the itemized parts sum to the total", () => {
    const n = normalizeUsage({
      model: "claude-sonnet-4-6",
      inputTokens: 1_000_000,
      outputTokens: 200_000,
      cacheReadTokens: 300_000,
      cacheWriteTokens: 100_000,
    })
    const c = priceUsage(n, MODEL_RATE_CARD, opts)
    expect(round(c.freshInputUsd + c.cacheReadUsd + c.cacheWriteUsd + c.outputUsd)).toBe(
      round(c.totalUsd),
    )
    expect(c.pricingKnown).toBe(true)
    expect(c.pricingModel).toBe("claude-sonnet-4-6")
    expect(c.pricingVersion).toBe(PRICING_VERSION)
  })

  test("cache-write is a real, separately-rated bucket", () => {
    // sonnet cacheWritePerM $3.75 ⇒ 100k = $0.375. This is the bucket the
    // total-cost entry point structurally cannot express.
    const n = normalizeUsage({
      model: "claude-sonnet-4-6",
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 100_000,
    })
    expect(priceUsage(n, MODEL_RATE_CARD, opts).cacheWriteUsd).toBeCloseTo(0.375, 9)
  })

  test("a provider that does not bill cache creation prices the bucket at $0", () => {
    // gpt-5.4 carries no cacheWritePerM — an absent rate is a $0 bucket, not a
    // missing price, so the model stays `pricingKnown`.
    const n = normalizeUsage({
      model: "gpt-5.4",
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 100_000,
    })
    const c = priceUsage(n, MODEL_RATE_CARD, opts)
    expect(c.cacheWriteUsd).toBe(0)
    expect(c.pricingKnown).toBe(true)
  })

  test("an unknown model with NO fallback is unpriceable, and says so", () => {
    const n = normalizeUsage({
      model: "mystery-model-99",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    })
    const c = priceUsage(n, MODEL_RATE_CARD, opts)
    expect(c.totalUsd).toBe(0)
    expect(c.pricingKnown).toBe(false)
  })

  test("an unknown model WITH a fallback is estimated, and still says so", () => {
    const n = normalizeUsage({
      model: "mystery-model-99",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    })
    const c = priceUsage(n, MODEL_RATE_CARD, { ...opts, fallbackModel: "claude-sonnet-4-6" })
    expect(c.totalUsd).toBeCloseTo(18, 9) // the estimate stays operator-visible
    expect(c.pricingKnown).toBe(false) // …but is never mistaken for measured
    expect(c.pricingModel).toBe("claude-sonnet-4-6") // and names the stand-in
  })

  test("a KNOWN model is never diverted to the fallback", () => {
    const n = normalizeUsage({ model: "claude-haiku-4-5", inputTokens: 1_000_000, outputTokens: 0 })
    const c = priceUsage(n, MODEL_RATE_CARD, { ...opts, fallbackModel: "claude-opus-4-7" })
    expect(c.pricingModel).toBe("claude-haiku-4-5")
    expect(c.totalUsd).toBeCloseTo(1, 9) // haiku's $1/M, not opus's $15/M
  })
})

describe("costUsd delegates without changing a single number", () => {
  test("normalize+price reproduces the shipped formula for every carded model", () => {
    // The wiring proof for the compatibility wrapper. Shapes are chosen to
    // exercise the provider branch: a pure-input call, a cache-heavy call, and
    // a mixed call. A drift on ANY model/shape pair fails here by name.
    const shapes = [
      { inputTokens: 250_000, outputTokens: 50_000, cacheReadTokens: 0 },
      { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 400_000 },
      { inputTokens: 900_000, outputTokens: 120_000, cacheReadTokens: 850_000 },
    ]
    const drift: string[] = []
    for (const model of Object.keys(MODEL_RATE_CARD)) {
      for (const shape of shapes) {
        const viaWrapper = costUsd(
          model,
          shape.inputTokens,
          shape.outputTokens,
          shape.cacheReadTokens,
        )
        const viaFormula = priceUsage(
          normalizeUsage({ model, ...shape }),
          MODEL_RATE_CARD,
          opts,
        ).totalUsd
        if (viaWrapper === null || round(viaWrapper) !== round(viaFormula)) {
          drift.push(
            `${model} ${JSON.stringify(shape)}: wrapper=${viaWrapper} formula=${viaFormula}`,
          )
        }
      }
    }
    expect(drift).toEqual([])
  })

  test("the wrapper still returns null for an unknown model", () => {
    expect(costUsd("mystery-model-99", 1_000_000, 1_000_000)).toBeNull()
  })
})
