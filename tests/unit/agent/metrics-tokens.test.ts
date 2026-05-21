/**
 * AgentRecorder.tokensUsed() — surface-side context-usage instrumentation
 * (Claude Desktop 1.7196.3 `getContextUsage` parity).
 *
 * The recorder forwards into the canonical OTel GenAI usage keys defined in
 * `src/observability/vocabulary.ts` (`gen_ai.usage.input_tokens` /
 * `gen_ai.usage.output_tokens` / `gen_ai.usage.cache_read_input_tokens`),
 * accumulating across calls so a CLI status line / future Tauri sidebar can
 * read a single counter snapshot. cacheRead is optional — its counter is
 * registered only when callers pass a value (matches the existing optional
 * shape of the `usage` StreamEvent).
 *
 * Pure-counter behaviour: no timers touched, no spurious recall/persist drift.
 */
import { describe, expect, test } from "bun:test"
import { AgentRecorder, METRIC } from "@/agent"
import { Metrics } from "@/observability"
import { GEN_AI_ATTRS } from "@/observability/vocabulary"

describe("METRIC.tokens* name table", () => {
  test("exposes the canonical OTel GenAI usage keys", () => {
    expect(METRIC.tokensInput).toBe(GEN_AI_ATTRS.usage.inputTokens)
    expect(METRIC.tokensOutput).toBe(GEN_AI_ATTRS.usage.outputTokens)
    expect(METRIC.cacheRead).toBe(GEN_AI_ATTRS.usage.cacheReadInputTokens)
  })
})

describe("AgentRecorder.tokensUsed", () => {
  test("single call forwards input/output into the canonical counters", () => {
    const m = new Metrics()
    const rec = new AgentRecorder(m)
    rec.tokensUsed(100, 50)
    const c = m.snapshot().counters
    expect(c[METRIC.tokensInput]).toBe(100)
    expect(c[METRIC.tokensOutput]).toBe(50)
    expect(c[METRIC.cacheRead] ?? 0).toBe(0)
  })

  test("repeat calls accumulate (sliding-window-friendly counter)", () => {
    const m = new Metrics()
    const rec = new AgentRecorder(m)
    rec.tokensUsed(100, 50)
    rec.tokensUsed(200, 70)
    rec.tokensUsed(0, 0)
    const c = m.snapshot().counters
    expect(c[METRIC.tokensInput]).toBe(300)
    expect(c[METRIC.tokensOutput]).toBe(120)
  })

  test("cacheRead is registered only when explicitly passed", () => {
    const m = new Metrics()
    const rec = new AgentRecorder(m)
    rec.tokensUsed(100, 50, 25)
    const c = m.snapshot().counters
    expect(c[METRIC.tokensInput]).toBe(100)
    expect(c[METRIC.tokensOutput]).toBe(50)
    expect(c[METRIC.cacheRead]).toBe(25)
  })

  test("cacheRead absent ⇒ no cache_read counter created at all", () => {
    const m = new Metrics()
    const rec = new AgentRecorder(m)
    rec.tokensUsed(10, 5)
    const c = m.snapshot().counters
    // The Metrics registry is lazy — absent keys ⇒ undefined entry.
    expect(c[METRIC.cacheRead]).toBeUndefined()
  })

  test("does not touch unrelated counters or any timer", () => {
    const m = new Metrics()
    const rec = new AgentRecorder(m)
    rec.tokensUsed(100, 50, 10)
    const snap = m.snapshot()
    expect(snap.counters[METRIC.turns] ?? 0).toBe(0)
    expect(snap.counters[METRIC.toolCalls] ?? 0).toBe(0)
    expect(snap.counters[METRIC.recallCalls] ?? 0).toBe(0)
    expect(snap.counters[METRIC.persistCalls] ?? 0).toBe(0)
    expect(snap.timers[METRIC.llmStream]?.count ?? 0).toBe(0)
    expect(snap.timers[METRIC.toolExec]?.count ?? 0).toBe(0)
  })

  test("zero values still register the counters (presence is meaningful)", () => {
    const m = new Metrics()
    const rec = new AgentRecorder(m)
    rec.tokensUsed(0, 0)
    const c = m.snapshot().counters
    expect(c[METRIC.tokensInput]).toBe(0)
    expect(c[METRIC.tokensOutput]).toBe(0)
  })
})
