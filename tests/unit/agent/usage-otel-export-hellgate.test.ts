/**
 * MR-06 hellgate — what the OTel counters export.
 *
 * Two counters existed in the canonical vocabulary with NOTHING incrementing
 * them: cache-creation tokens, and the derived USD cost. A dashboard could get
 * the cost only by re-running pricing over the token counters, which
 * re-invents the formula downstream and silently re-pays for the unknown-model
 * cases the pricer deliberately refuses.
 *
 * The token counters stay PROVIDER-SHAPED. `gen_ai.usage.*` is OpenTelemetry
 * GenAI semconv and those keys mean what the provider reported — for OpenAI
 * that already contains the cached portion, for Anthropic it does not. Pushing
 * the canonical disjoint buckets through them was tried and measured: a
 * consumer that carves cache out again turned a $1.60 turn into $0.60. So the
 * normalization stays on the accounting side of the boundary, and only the two
 * genuinely-missing values are exported from the canonical record.
 */
import { describe, expect, test } from "bun:test"
import { emitUsage } from "@/agent/loop/emit-helpers"
import { AgentRecorder } from "@/agent/metrics"
import type { AgentConfig } from "@/agent/types"
import type { StreamEvent } from "@/llm"
import { GEN_AI_ATTRS, QUANTA_ATTRS } from "@/observability"
import { Metrics } from "@/observability/metrics"

type UsageEv = Extract<StreamEvent, { type: "usage" }>

const K = {
  input: GEN_AI_ATTRS.usage.inputTokens,
  output: GEN_AI_ATTRS.usage.outputTokens,
  cacheRead: GEN_AI_ATTRS.usage.cacheReadInputTokens,
  cacheWrite: GEN_AI_ATTRS.usage.cacheCreationInputTokens,
  cost: QUANTA_ATTRS.work.costUsd,
}

const exported = (ev: Partial<UsageEv> & { model: string }) => {
  const metrics = new Metrics()
  const config = {
    llm: { stream: async function* () {} },
    registry: { get: () => undefined, specs: () => [], isReadOnly: () => true },
    stream: { emit: () => undefined },
    permission: { mode: "acceptEdits" },
    messages: [],
    system: "t",
    cwd: process.cwd(),
    maxTurns: 1,
    signal: new AbortController().signal,
    sessionId: "s",
  } as unknown as AgentConfig
  emitUsage(
    config,
    { type: "usage", inputTokens: 0, outputTokens: 0, ...ev } as UsageEv,
    new AgentRecorder(metrics),
    undefined,
    undefined,
  )
  return metrics.snapshot().counters
}

describe("the token counters stay provider-shaped", () => {
  test("input is what the provider reported, cache-read alongside it", () => {
    // gpt-5.4 reports 1M prompt of which 400k were cached. Semconv wants the
    // reported 1M here, NOT the 600k fresh — a consumer that re-prices from
    // these keys applies the provider rule itself.
    const c = exported({ model: "gpt-5.4", inputTokens: 1_000_000, cacheReadTokens: 400_000 })
    expect(c[K.input]).toBe(1_000_000)
    expect(c[K.cacheRead]).toBe(400_000)
  })

  test("an absent cache-read stays absent rather than becoming 0", () => {
    const c = exported({ model: "claude-sonnet-4-6", inputTokens: 100, outputTokens: 50 })
    expect(c[K.input]).toBe(100)
    expect(c[K.output]).toBe(50)
    expect(c[K.cacheRead]).toBeUndefined()
  })
})

describe("the two counters that had no emit site", () => {
  test("cache-write is exported", () => {
    const c = exported({
      model: "claude-sonnet-4-6",
      inputTokens: 0,
      cacheCreationTokens: 100_000,
    })
    expect(c[K.cacheWrite]).toBe(100_000)
  })

  test("the priced cost is exported, cache-write included", () => {
    // sonnet: 1M input @ $3 + 100k cache-write @ $3.75/M = $3.375. The cost
    // counter carries the number instead of leaving it to be re-derived.
    const c = exported({
      model: "claude-sonnet-4-6",
      inputTokens: 1_000_000,
      cacheCreationTokens: 100_000,
    })
    expect(c[K.cost]).toBeCloseTo(3.375, 9)
  })

  test("an unpriced model exports tokens but NOT a cost", () => {
    // A counter cannot say "this figure is an estimate", and a dashboard total
    // that silently contains guesses is the failure being undone. Tokens are
    // still exported, so the spend is not invisible.
    const c = exported({ model: "mystery-model-99", inputTokens: 1_000_000, outputTokens: 500_000 })
    expect(c[K.input]).toBe(1_000_000)
    expect(c[K.output]).toBe(500_000)
    expect(c[K.cost]).toBeUndefined()
  })

  // PAIRED CONTROL — a priced model DOES reach the cost counter, so the rule
  // above cannot be satisfied by never exporting cost at all.
  test("PAIRED CONTROL: a priced model reaches the cost counter (must stay green)", () => {
    const c = exported({ model: "claude-sonnet-4-6", inputTokens: 1_000_000 })
    expect(c[K.cost]).toBeCloseTo(3, 9)
  })
})
