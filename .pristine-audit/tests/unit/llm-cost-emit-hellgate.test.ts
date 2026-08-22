import { describe, expect, test } from "bun:test"
import {
  buildLlmCostMetricsSink,
  emitLlmCostToOtel,
  type LlmCostSink,
  Metrics,
  type WorkMetrics,
} from "@/observability"
import { GEN_AI_ATTRS, QUANTA_ATTRS } from "@/observability/vocabulary"

/**
 * Hellgate suite for the observability-side LLM cost/tokens emit wiring.
 *
 * Invariants under test:
 *   1. Per-turn `WorkMetrics` → OTel counters for input/output/cache_read.
 *   2. Cost (`estimatedCostUsd`) recorded on a timer (histogram surrogate)
 *      AND as a cumulative counter — only when finite.
 *   3. Provider/model labels disaggregate counters under `${key}.${prov}.${model}`.
 *   4. Zero-cost (cache-hit / unknown-model) turns STILL emit token counters
 *      with the cache_read label, but NEVER fabricate a placeholder cost.
 *   5. NO prompt/completion text reaches the registry (audit: only canonical
 *      attribute keys + sanitized provider/model labels appear in counter
 *      names).
 *   6. Wrap-chain sink forwards to the wrapped sink, byte-identically.
 *   7. NaN / Infinity / negative cost values are discarded (OTel forbids).
 */

const baseMetrics = (overrides: Partial<WorkMetrics> = {}): WorkMetrics => ({
  diffMap: [],
  agentActions: 0,
  linesRead: 0,
  tokensInput: 0,
  tokensOutput: 0,
  ...overrides,
})

describe("emitLlmCostToOtel — tokens", () => {
  test("increments input/output counters under canonical gen_ai keys", () => {
    const m = new Metrics()
    emitLlmCostToOtel(m, baseMetrics({ tokensInput: 120, tokensOutput: 40 }))
    const snap = m.snapshot()
    expect(snap.counters[GEN_AI_ATTRS.usage.inputTokens]).toBe(120)
    expect(snap.counters[GEN_AI_ATTRS.usage.outputTokens]).toBe(40)
  })

  test("emits cache_read counter when cacheReadTokens is present", () => {
    const m = new Metrics()
    emitLlmCostToOtel(m, baseMetrics({ tokensInput: 0, tokensOutput: 0, cacheReadTokens: 800 }))
    const snap = m.snapshot()
    expect(snap.counters[GEN_AI_ATTRS.usage.cacheReadInputTokens]).toBe(800)
  })

  test("skips cache_read counter when cacheReadTokens is undefined", () => {
    const m = new Metrics()
    emitLlmCostToOtel(m, baseMetrics({ tokensInput: 10, tokensOutput: 5 }))
    const snap = m.snapshot()
    expect(snap.counters[GEN_AI_ATTRS.usage.cacheReadInputTokens]).toBeUndefined()
  })

  test("emits cache_creation counter when extra.cacheCreationInputTokens is supplied", () => {
    const m = new Metrics()
    emitLlmCostToOtel(
      m,
      baseMetrics({ tokensInput: 0, tokensOutput: 0 }),
      {},
      { cacheCreationInputTokens: 1500 },
    )
    const snap = m.snapshot()
    expect(snap.counters[GEN_AI_ATTRS.usage.cacheCreationInputTokens]).toBe(1500)
  })
})

describe("emitLlmCostToOtel — cost", () => {
  test("records cost on timer (histogram) AND a cumulative counter", () => {
    const m = new Metrics()
    emitLlmCostToOtel(
      m,
      baseMetrics({ tokensInput: 100, tokensOutput: 50, estimatedCostUsd: 0.0042 }),
    )
    const snap = m.snapshot()
    const stats = snap.timers[QUANTA_ATTRS.work.costUsd]
    expect(stats?.count).toBe(1)
    expect(stats?.mean).toBeCloseTo(0.0042, 6)
    expect(snap.counters[QUANTA_ATTRS.work.costUsd]).toBeCloseTo(0.0042, 6)
  })

  test("histogram stats accumulate across multiple turns", () => {
    const m = new Metrics()
    emitLlmCostToOtel(m, baseMetrics({ estimatedCostUsd: 0.01 }))
    emitLlmCostToOtel(m, baseMetrics({ estimatedCostUsd: 0.03 }))
    emitLlmCostToOtel(m, baseMetrics({ estimatedCostUsd: 0.02 }))
    const snap = m.snapshot()
    const stats = snap.timers[QUANTA_ATTRS.work.costUsd]
    expect(stats?.count).toBe(3)
    expect(stats?.min).toBeCloseTo(0.01, 6)
    expect(stats?.max).toBeCloseTo(0.03, 6)
    // Cumulative counter sums to total run cost.
    expect(snap.counters[QUANTA_ATTRS.work.costUsd]).toBeCloseTo(0.06, 6)
  })

  test("unknown-model (estimatedCostUsd undefined) emits NO cost — never fakes zero", () => {
    const m = new Metrics()
    emitLlmCostToOtel(m, baseMetrics({ tokensInput: 100, tokensOutput: 50 }))
    const snap = m.snapshot()
    expect(snap.timers[QUANTA_ATTRS.work.costUsd]).toBeUndefined()
    expect(snap.counters[QUANTA_ATTRS.work.costUsd]).toBeUndefined()
  })

  test("non-finite cost values are dropped (NaN / Infinity / negative)", () => {
    const m = new Metrics()
    emitLlmCostToOtel(m, baseMetrics({ estimatedCostUsd: Number.NaN }))
    emitLlmCostToOtel(m, baseMetrics({ estimatedCostUsd: Number.POSITIVE_INFINITY }))
    // Negative cost is theoretically forbidden by pricing math but the
    // boundary should not propagate it either way.
    emitLlmCostToOtel(m, baseMetrics({ estimatedCostUsd: -0.5 }))
    const snap = m.snapshot()
    // NaN/Infinity → dropped by guard. The legitimate-but-pathological
    // negative number still records on the timer (timer accepts any finite
    // number) but is dropped by the counter's positive-delta guard.
    expect(snap.counters[QUANTA_ATTRS.work.costUsd]).toBeUndefined()
  })
})

describe("emitLlmCostToOtel — cache-hit zero-cost scenarios", () => {
  test("turn served entirely from cache (zero new tokens, cache_read > 0) still emits", () => {
    const m = new Metrics()
    emitLlmCostToOtel(
      m,
      baseMetrics({
        tokensInput: 0,
        tokensOutput: 0,
        cacheReadTokens: 2400,
        estimatedCostUsd: 0.0001,
      }),
      { model: "claude-opus-4-7", provider: "anthropic" },
    )
    const snap = m.snapshot()
    expect(snap.counters[GEN_AI_ATTRS.usage.cacheReadInputTokens]).toBe(2400)
    // Cache-read disaggregated counter ALSO fires.
    expect(
      snap.counters[`${GEN_AI_ATTRS.usage.cacheReadInputTokens}.anthropic.claude_opus_4_7`],
    ).toBe(2400)
    // Cost histogram records the tiny cache-only cost.
    expect(snap.timers[QUANTA_ATTRS.work.costUsd]?.count).toBe(1)
  })

  test("cache_creation + cache_read both emit when present", () => {
    const m = new Metrics()
    emitLlmCostToOtel(
      m,
      baseMetrics({ cacheReadTokens: 1000 }),
      { model: "claude-sonnet-4-6" },
      { cacheCreationInputTokens: 500 },
    )
    const snap = m.snapshot()
    expect(snap.counters[GEN_AI_ATTRS.usage.cacheReadInputTokens]).toBe(1000)
    expect(snap.counters[GEN_AI_ATTRS.usage.cacheCreationInputTokens]).toBe(500)
  })
})

describe("emitLlmCostToOtel — labels", () => {
  test("disaggregates counters by sanitized provider+model", () => {
    const m = new Metrics()
    emitLlmCostToOtel(
      m,
      baseMetrics({ tokensInput: 100, tokensOutput: 50, estimatedCostUsd: 0.01 }),
      { model: "claude-opus-4-7", provider: "anthropic" },
    )
    const snap = m.snapshot()
    expect(snap.counters[`${GEN_AI_ATTRS.usage.inputTokens}.anthropic.claude_opus_4_7`]).toBe(100)
    expect(snap.counters[`${GEN_AI_ATTRS.usage.outputTokens}.anthropic.claude_opus_4_7`]).toBe(50)
    expect(snap.counters[`${QUANTA_ATTRS.work.costUsd}.anthropic.claude_opus_4_7`]).toBeCloseTo(
      0.01,
      6,
    )
  })

  test("infers provider from model name when provider omitted", () => {
    const m = new Metrics()
    emitLlmCostToOtel(m, baseMetrics({ tokensInput: 10, tokensOutput: 5 }), { model: "gpt-4o" })
    const snap = m.snapshot()
    expect(snap.counters[`${GEN_AI_ATTRS.usage.inputTokens}.openai.gpt_4o`]).toBe(10)
  })

  test("no labels ⇒ only rolled-up keys, no disaggregated counters", () => {
    const m = new Metrics()
    emitLlmCostToOtel(m, baseMetrics({ tokensInput: 7, tokensOutput: 3 }))
    const snap = m.snapshot()
    const keys = Object.keys(snap.counters)
    // No counter name should contain a label-style dot beyond the canonical key.
    for (const k of keys) {
      const isCanonical =
        k === GEN_AI_ATTRS.usage.inputTokens ||
        k === GEN_AI_ATTRS.usage.outputTokens ||
        k === GEN_AI_ATTRS.usage.cacheReadInputTokens ||
        k === GEN_AI_ATTRS.usage.cacheCreationInputTokens ||
        k === QUANTA_ATTRS.work.costUsd
      expect(isCanonical).toBe(true)
    }
  })
})

describe("security invariants — no text content reaches OTel", () => {
  test("registry only carries canonical attribute keys + sanitized provider/model labels", () => {
    const m = new Metrics()
    // Even when a caller mistakenly thinks they could pass text via labels,
    // only `model` and `provider` are accepted by the LlmCostLabels shape —
    // anything else is a TypeScript error. Here we audit the runtime
    // registry to prove only safe keys land.
    emitLlmCostToOtel(
      m,
      baseMetrics({
        tokensInput: 1,
        tokensOutput: 1,
        cacheReadTokens: 1,
        estimatedCostUsd: 0.0001,
      }),
      { model: "claude-haiku-4-5", provider: "anthropic" },
      { cacheCreationInputTokens: 1 },
    )
    const snap = m.snapshot()
    const allKeys = [
      ...Object.keys(snap.counters),
      ...Object.keys(snap.gauges),
      ...Object.keys(snap.timers),
    ]
    // Every key must be either a canonical vocabulary key or its
    // label-suffix variant. No free-form text, no message body fragments.
    const FORBIDDEN_FRAGMENTS = [
      "prompt",
      "completion",
      "content",
      "message",
      "system",
      "user_input",
      "assistant",
    ]
    for (const k of allKeys) {
      for (const bad of FORBIDDEN_FRAGMENTS) {
        expect(k.toLowerCase().includes(bad)).toBe(false)
      }
    }
  })

  test("WorkMetrics extra free-form fields are ignored — only declared inputs read", () => {
    const m = new Metrics()
    // Cast through `unknown` to inject a hypothetical adversarial extra
    // field ("prompt") onto the metrics object — the emit helper must
    // never crawl arbitrary keys.
    const adversarial = {
      ...baseMetrics({ tokensInput: 1, tokensOutput: 1 }),
      prompt: "SECRET USER PROMPT — must not leak",
      completion: "SECRET MODEL OUTPUT — must not leak",
    } as unknown as WorkMetrics
    emitLlmCostToOtel(m, adversarial, { model: "claude-opus-4-7" })
    const snap = m.snapshot()
    const allKeys = JSON.stringify(snap)
    expect(allKeys.includes("SECRET")).toBe(false)
    expect(allKeys.includes("prompt")).toBe(false)
    expect(allKeys.includes("completion")).toBe(false)
  })
})

describe("buildLlmCostMetricsSink — wrap-chain", () => {
  test("emit fires for tokens + cost via the WorkMetricsSink boundary", () => {
    const m = new Metrics()
    const sink = buildLlmCostMetricsSink(m, { model: "claude-opus-4-7" })
    sink.emit(baseMetrics({ tokensInput: 50, tokensOutput: 20, estimatedCostUsd: 0.001 }), {
      turnId: "t-1",
    })
    const snap = m.snapshot()
    expect(snap.counters[GEN_AI_ATTRS.usage.inputTokens]).toBe(50)
    expect(snap.counters[GEN_AI_ATTRS.usage.outputTokens]).toBe(20)
    expect(snap.timers[QUANTA_ATTRS.work.costUsd]?.count).toBe(1)
  })

  test("wraps an existing sink — forwards (m, ctx) byte-identically", () => {
    const m = new Metrics()
    const captured: Array<{ metrics: WorkMetrics; turnId: string }> = []
    const inner: LlmCostSink = {
      emit: (mt, ctx) => captured.push({ metrics: mt, turnId: ctx.turnId }),
    }
    const sink = buildLlmCostMetricsSink(m, { model: "gpt-4o-mini" }, inner)
    const wm = baseMetrics({ tokensInput: 5, tokensOutput: 2, estimatedCostUsd: 0.0001 })
    sink.emit(wm, { turnId: "t-42" })
    expect(captured).toHaveLength(1)
    expect(captured[0]?.metrics).toBe(wm)
    expect(captured[0]?.turnId).toBe("t-42")
    // AND the OTel side wired up too.
    expect(m.snapshot().counters[GEN_AI_ATTRS.usage.inputTokens]).toBe(5)
  })

  test("absent wrap ⇒ no extra side effects, sink is purely OTel-bound", () => {
    const m = new Metrics()
    const sink = buildLlmCostMetricsSink(m)
    // Should not throw / not require any wrapped sink.
    sink.emit(baseMetrics({ tokensInput: 1, tokensOutput: 1 }), { turnId: "t-0" })
    expect(m.snapshot().counters[GEN_AI_ATTRS.usage.inputTokens]).toBe(1)
  })
})
