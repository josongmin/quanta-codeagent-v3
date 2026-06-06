import { describe, expect, test } from "bun:test"
import { captureTokenBaseline } from "@/agent/loop/stream-consume"

/**
 * D5 (jun-7 naive-impl hardening) — the token-baseline capture MUST fold the
 * cache-read + cache-creation buckets into the authoritative input count.
 *
 * Anthropic reports `inputTokens` as the cache-MISS portion only. With prompt
 * caching on every turn, a cache-HIT turn reports a few hundred `inputTokens`
 * while the real prompt is ~100k+. If the capture used `inputTokens` alone it
 * would (a) fail the `>= sentEstimate` exactness gate on every cached turn so the
 * baseline never refreshes, and (b) — were the gate loosened — under-count the
 * true prompt by the cache-read amount, the exact under-trigger D5 prevents.
 *
 * Red-on-injection: drop the `+ cacheReadTokens + cacheCreationTokens` and the
 * "cached turn" case below stops capturing (fullInput 200 < 120000).
 */
describe("captureTokenBaseline — cache-bucket inclusion (D5)", () => {
  const box = (sendCount?: number) => ({ sendCount, current: undefined as undefined | object })

  test("cache-HIT turn: inputTokens(200)+cacheRead(149800) ⇒ 150k authoritative captured", () => {
    const b = box(10)
    captureTokenBaseline(b, { inputTokens: 200, cacheReadTokens: 149_800 }, 120_000)
    expect(b.current).toEqual({ measuredInputTokens: 150_000, measuredAtMessageCount: 10 })
  })

  test("cache-creation bucket also counted toward the authoritative input", () => {
    const b = box(7)
    captureTokenBaseline(b, { inputTokens: 1_000, cacheCreationTokens: 130_000 }, 120_000)
    expect(b.current).toEqual({ measuredInputTokens: 131_000, measuredAtMessageCount: 7 })
  })

  test("inputTokens ALONE below the sent estimate does NOT capture (the bug)", () => {
    // This is the pre-fix behaviour for a cached turn: without the cache buckets
    // the count (200) is below the estimate (120k) so nothing is captured.
    const b = box(10)
    captureTokenBaseline(b, { inputTokens: 200 }, 120_000)
    expect(b.current).toBeUndefined()
  })

  test("non-cached exact turn (inputTokens >= estimate) captures as before", () => {
    const b = box(5)
    captureTokenBaseline(b, { inputTokens: 130_000 }, 120_000)
    expect(b.current).toEqual({ measuredInputTokens: 130_000, measuredAtMessageCount: 5 })
  })

  test("no sendCount yet ⇒ no capture (send-time count not recorded)", () => {
    const b = box(undefined)
    captureTokenBaseline(b, { inputTokens: 200, cacheReadTokens: 149_800 }, 120_000)
    expect(b.current).toBeUndefined()
  })

  test("undefined box ⇒ no-op (compaction not configured)", () => {
    expect(() =>
      captureTokenBaseline(undefined, { inputTokens: 200, cacheReadTokens: 149_800 }, 120_000),
    ).not.toThrow()
  })

  test("non-finite authoritative input is ignored (fail-safe)", () => {
    const b = box(3)
    captureTokenBaseline(b, { inputTokens: Number.NaN, cacheReadTokens: 149_800 }, 120_000)
    expect(b.current).toBeUndefined()
  })
})
