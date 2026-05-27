/**
 * ADR-0352 — Cache metrics decorator hellgate.
 *
 * Pins: identity preservation, hit/miss/invalidation counter semantics,
 * peek read-only counter split, clearAll batch delta, NO-THROW.
 */
import { describe, expect, test } from "bun:test"
import { asCacheKey, createInMemorySystemPromptCache } from "@/llm/system-prompt-cache"
import { withCacheMetrics } from "@/observability/codex-r2-metrics/cache-metrics-decorator"
import type { MetricEmitterPort } from "@/observability/codex-r2-metrics/types"

interface Capture {
  counters: Array<{ name: string; delta: number; attrs?: Readonly<Record<string, string>> }>
  gauges: Array<{ name: string; value: number; attrs?: Readonly<Record<string, string>> }>
}

const mkCapture = (): { emitter: MetricEmitterPort; cap: Capture } => {
  const cap: Capture = { counters: [], gauges: [] }
  const emitter: MetricEmitterPort = {
    counter: (name, delta, attrs) => {
      const entry: Capture["counters"][number] =
        attrs === undefined ? { name, delta } : { name, delta, attrs }
      cap.counters.push(entry)
    },
    gauge: (name, value, attrs) => {
      const entry: Capture["gauges"][number] =
        attrs === undefined ? { name, value } : { name, value, attrs }
      cap.gauges.push(entry)
    },
  }
  return { emitter, cap }
}

const countsFor = (cap: Capture, name: string): number =>
  cap.counters.filter((c) => c.name === name).reduce((a, c) => a + c.delta, 0)

describe("ADR-0352 — withCacheMetrics", () => {
  test("A. wrap is identity-preserving on getOrBuild — same text, same hash", () => {
    const { emitter } = mkCapture()
    const inner = createInMemorySystemPromptCache()
    const wrapped = withCacheMetrics(inner, { emitter })
    const direct = inner.getOrBuild(asCacheKey("d"), () => "PROMPT")
    const through = wrapped.getOrBuild(asCacheKey("w"), () => "PROMPT")
    expect(through.text).toBe(direct.text)
    expect(through.contentHash).toBe(direct.contentHash)
  })

  test("B. getOrBuild miss ⇒ counter cache.misses fires", () => {
    const { emitter, cap } = mkCapture()
    const wrapped = withCacheMetrics(createInMemorySystemPromptCache(), { emitter })
    wrapped.getOrBuild(asCacheKey("k"), () => "x")
    expect(countsFor(cap, "codex_r2.cache.misses")).toBe(1)
    expect(countsFor(cap, "codex_r2.cache.hits")).toBe(0)
  })

  test("C. getOrBuild same key second time ⇒ counter cache.hits fires", () => {
    const { emitter, cap } = mkCapture()
    const wrapped = withCacheMetrics(createInMemorySystemPromptCache(), { emitter })
    wrapped.getOrBuild(asCacheKey("k"), () => "x")
    wrapped.getOrBuild(asCacheKey("k"), () => "x")
    expect(countsFor(cap, "codex_r2.cache.misses")).toBe(1)
    expect(countsFor(cap, "codex_r2.cache.hits")).toBe(1)
  })

  test("D. invalidate of present key ⇒ counter cache.invalidations fires with reason attr", () => {
    const { emitter, cap } = mkCapture()
    const wrapped = withCacheMetrics(createInMemorySystemPromptCache(), { emitter })
    wrapped.getOrBuild(asCacheKey("k"), () => "x")
    wrapped.invalidate(asCacheKey("k"), "config_change")
    const inv = cap.counters.filter((c) => c.name === "codex_r2.cache.invalidations")
    expect(inv).toHaveLength(1)
    expect(inv[0]?.attrs?.reason).toBe("config_change")
  })

  test("E. invalidate of absent key ⇒ no counter (cache stayed empty)", () => {
    const { emitter, cap } = mkCapture()
    const wrapped = withCacheMetrics(createInMemorySystemPromptCache(), { emitter })
    wrapped.invalidate(asCacheKey("nope"), "manual_reset")
    expect(countsFor(cap, "codex_r2.cache.invalidations")).toBe(0)
  })

  test("F. clearAll on populated cache ⇒ counter delta == size before", () => {
    const { emitter, cap } = mkCapture()
    const wrapped = withCacheMetrics(createInMemorySystemPromptCache(), { emitter })
    wrapped.getOrBuild(asCacheKey("a"), () => "x")
    wrapped.getOrBuild(asCacheKey("b"), () => "y")
    wrapped.getOrBuild(asCacheKey("c"), () => "z")
    wrapped.clearAll("session_end")
    expect(countsFor(cap, "codex_r2.cache.invalidations")).toBe(3)
  })

  test("G. clearAll on empty cache ⇒ no counter (delta would be 0)", () => {
    const { emitter, cap } = mkCapture()
    const wrapped = withCacheMetrics(createInMemorySystemPromptCache(), { emitter })
    wrapped.clearAll("session_end")
    expect(countsFor(cap, "codex_r2.cache.invalidations")).toBe(0)
  })

  test("H. peek hit ⇒ counter cache.peek_hits, peek miss ⇒ peek_misses", () => {
    const { emitter, cap } = mkCapture()
    const wrapped = withCacheMetrics(createInMemorySystemPromptCache(), { emitter })
    wrapped.peek(asCacheKey("k")) // miss
    wrapped.getOrBuild(asCacheKey("k"), () => "x")
    wrapped.peek(asCacheKey("k")) // hit
    expect(countsFor(cap, "codex_r2.cache.peek_misses")).toBe(1)
    expect(countsFor(cap, "codex_r2.cache.peek_hits")).toBe(1)
  })

  test("I. emitter throws ⇒ swallowed, cache method still returns", () => {
    const throwingEmitter: MetricEmitterPort = {
      counter: () => {
        throw new Error("emitter boom")
      },
      gauge: () => {
        throw new Error("emitter boom")
      },
    }
    const wrapped = withCacheMetrics(createInMemorySystemPromptCache(), {
      emitter: throwingEmitter,
    })
    const out = wrapped.getOrBuild(asCacheKey("k"), () => "x")
    expect(out.text).toBe("x")
  })

  test("J. prefix override ⇒ metric names re-rooted", () => {
    const { emitter, cap } = mkCapture()
    const wrapped = withCacheMetrics(createInMemorySystemPromptCache(), {
      emitter,
      prefix: "alt",
    })
    wrapped.getOrBuild(asCacheKey("k"), () => "x")
    expect(countsFor(cap, "alt.cache.misses")).toBe(1)
    expect(countsFor(cap, "codex_r2.cache.misses")).toBe(0)
  })

  test("K. stats() ⇒ gauge codex_r2.cache.size emitted with current size", () => {
    const { emitter, cap } = mkCapture()
    const wrapped = withCacheMetrics(createInMemorySystemPromptCache(), { emitter })
    wrapped.getOrBuild(asCacheKey("a"), () => "x")
    wrapped.getOrBuild(asCacheKey("b"), () => "y")
    const s = wrapped.stats()
    expect(s.size).toBe(2)
    const sizeGauges = cap.gauges.filter((g) => g.name === "codex_r2.cache.size")
    expect(sizeGauges).toHaveLength(1)
    expect(sizeGauges[0]?.value).toBe(2)
  })
})
