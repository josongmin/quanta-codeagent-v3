import { describe, expect, test } from "bun:test"
import { captureTokenBaseline } from "@/agent/loop/stream-consume"

/**
 * D5 (jun-7 naive-impl hardening) — the token-baseline capture folds the
 * provider usage into an authoritative input count. The cache-bucket arithmetic
 * is PROVIDER-DEPENDENT (mirroring `costUsd`/`providerOf` in @/observability):
 *  - **anthropic**: `inputTokens` EXCLUDES cache reads → full = inputTokens +
 *    cacheRead + cacheCreation. A cache-HIT turn reports ~200 inputTokens while
 *    the real prompt is ~100k+; without the buckets the `>= sentEstimate` gate
 *    fails every cached turn and the baseline never refreshes.
 *  - **openai**: `prompt_tokens` (our inputTokens) ALREADY INCLUDES cached →
 *    full = inputTokens. Adding cacheRead DOUBLE-counts (records a baseline far
 *    above the real prompt → premature compaction discarding history).
 *
 * Red-on-injection: drop the anthropic bucket-sum ⇒ the cache-HIT case stops
 * capturing; drop the openai branch ⇒ the OpenAI case double-counts to 190k.
 */
const ANTHROPIC = "claude-opus-4-8"
const OPENAI = "gpt-5"

describe("captureTokenBaseline — provider-aware cache buckets (D5)", () => {
  const box = (sendCount?: number) => ({ sendCount, current: undefined as undefined | object })

  test("anthropic cache-HIT: inputTokens(200)+cacheRead(149800) ⇒ 150k captured", () => {
    const b = box(10)
    captureTokenBaseline(b, { inputTokens: 200, cacheReadTokens: 149_800, model: ANTHROPIC }, 120_000)
    expect(b.current).toEqual({ measuredInputTokens: 150_000, measuredAtMessageCount: 10 })
  })

  test("anthropic cache-creation bucket also counted", () => {
    const b = box(7)
    captureTokenBaseline(b, { inputTokens: 1_000, cacheCreationTokens: 130_000, model: ANTHROPIC }, 120_000)
    expect(b.current).toEqual({ measuredInputTokens: 131_000, measuredAtMessageCount: 7 })
  })

  test("OPENAI does NOT add cacheRead (prompt_tokens already includes it) — no double-count", () => {
    // OpenAI `prompt_tokens`=100k already includes the 90k cached subset. Adding
    // cacheRead would record 190k (~2x the real prompt) → premature compaction.
    // Red-on-injection: drop the openai branch ⇒ measuredInputTokens === 190_000.
    const b = box(4)
    captureTokenBaseline(b, { inputTokens: 100_000, cacheReadTokens: 90_000, model: OPENAI }, 50_000)
    expect(b.current).toEqual({ measuredInputTokens: 100_000, measuredAtMessageCount: 4 })
  })

  test("anthropic inputTokens ALONE below the estimate does NOT capture (the cached-turn bug)", () => {
    const b = box(10)
    captureTokenBaseline(b, { inputTokens: 200, model: ANTHROPIC }, 120_000)
    expect(b.current).toBeUndefined()
  })

  test("non-cached exact turn (inputTokens >= estimate) captures", () => {
    const b = box(5)
    captureTokenBaseline(b, { inputTokens: 130_000, model: ANTHROPIC }, 120_000)
    expect(b.current).toEqual({ measuredInputTokens: 130_000, measuredAtMessageCount: 5 })
  })

  test("no sendCount yet ⇒ no capture (send-time count not recorded)", () => {
    const b = box(undefined)
    captureTokenBaseline(b, { inputTokens: 200, cacheReadTokens: 149_800, model: ANTHROPIC }, 120_000)
    expect(b.current).toBeUndefined()
  })

  test("undefined box ⇒ no-op (compaction not configured)", () => {
    expect(() =>
      captureTokenBaseline(
        undefined,
        { inputTokens: 200, cacheReadTokens: 149_800, model: ANTHROPIC },
        120_000,
      ),
    ).not.toThrow()
  })

  test("non-finite authoritative input is ignored (fail-safe)", () => {
    const b = box(3)
    captureTokenBaseline(b, { inputTokens: Number.NaN, cacheReadTokens: 149_800, model: ANTHROPIC }, 120_000)
    expect(b.current).toBeUndefined()
  })
})
