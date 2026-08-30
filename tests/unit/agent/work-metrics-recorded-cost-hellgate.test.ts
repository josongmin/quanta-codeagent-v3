/**
 * A4 hellgate — the per-turn work metrics consume the RECORDED cost.
 *
 * `finalize()` used to re-price its per-model buckets through `costUsd`, which
 * has no cache-write parameter and silently skips unknown models. Two honest
 * failures followed: a turn that warmed the prompt cache under-reported by the
 * whole cache-write bill, and a mixed known/unknown turn presented its partial
 * sum with a complete total's confidence.
 *
 * The loop already prices every event exactly once (`eventCost` in the
 * emitUsage fan-out); the collector now receives THAT, and only falls back to
 * deriving when no recorded cost ever arrived (direct callers, old fixtures).
 */
import { describe, expect, test } from "bun:test"
import { emitUsage } from "@/agent/loop/emit-helpers"
import type { AgentConfig } from "@/agent/types"
import { TurnWorkMetricsCollector } from "@/agent/work-metrics-collector"
import type { StreamEvent } from "@/llm"
import { summarizeWorkMetrics } from "@/observability"

type UsageEv = Extract<StreamEvent, { type: "usage" }>

const drive = (collector: TurnWorkMetricsCollector, ev: Partial<UsageEv> & { model: string }) => {
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
    undefined,
    collector,
    undefined,
  )
}

describe("A4 — the turn's cost is what the loop actually billed", () => {
  test("a cache-write turn is billed in full (3.375, not 3.0)", () => {
    // sonnet: 1M input ($3) + 100k cache-creation ($0.375). `costUsd` cannot
    // express the second term, so the old derive under-reported it to $3.
    const collector = new TurnWorkMetricsCollector()
    drive(collector, {
      model: "claude-sonnet-4-6",
      inputTokens: 1_000_000,
      cacheCreationTokens: 100_000,
    })
    expect(collector.finalize("claude-sonnet-4-6").estimatedCostUsd).toBeCloseTo(3.375, 9)
  })

  test("a mixed known/unknown turn names its gap instead of impersonating a total", () => {
    const collector = new TurnWorkMetricsCollector()
    drive(collector, { model: "claude-sonnet-4-6", inputTokens: 1_000_000 }) // $3 known
    drive(collector, { model: "mystery-model-99", inputTokens: 1_000_000 }) // unpriced
    const m = collector.finalize("claude-sonnet-4-6")
    expect(m.estimatedCostUsd).toBeCloseTo(3, 9) // the known part, a floor
    expect(m.unpricedCalls).toBe(1) // …and the gap is carried, not absorbed
    expect(summarizeWorkMetrics(m)).toContain("unpriced")
  })

  test("CONTROL: a fully-priced turn carries no unpriced marker", () => {
    const collector = new TurnWorkMetricsCollector()
    drive(collector, { model: "claude-sonnet-4-6", inputTokens: 1_000_000 })
    const m = collector.finalize("claude-sonnet-4-6")
    expect(m.unpricedCalls).toBeUndefined()
    expect(summarizeWorkMetrics(m)).not.toContain("unpriced")
  })

  test("a FALLBACK-priced record (unknown, $>0) never inflates the known total", () => {
    // The loop's unknown events cost $0, so absorbing them would be invisible
    // there — but a direct caller can hand a fallback estimate (the ledger's
    // shape: pricingKnown:false with a real amount). That guess must land in
    // the unpriced count, never in the confident total.
    const collector = new TurnWorkMetricsCollector()
    collector.recordUsage({
      tokensInput: 1_000_000,
      tokensOutput: 0,
      model: "mystery-model-99",
      cost: {
        totalUsd: 5,
        freshInputUsd: 5,
        cacheReadUsd: 0,
        cacheWriteUsd: 0,
        outputUsd: 0,
        pricingKnown: false,
        pricingModel: "claude-sonnet-4-6",
        pricingVersion: "test",
      },
    })
    const m = collector.finalize()
    expect(m.estimatedCostUsd).toBe(0) // the guess is not a measurement
    expect(m.unpricedCalls).toBe(1)
  })

  test("CONTROL: a direct caller with no recorded cost keeps the derive fallback", () => {
    // Old fixtures and record-less callers hand tokens straight to the
    // collector; their number must not change.
    const collector = new TurnWorkMetricsCollector()
    collector.recordUsage({ tokensInput: 1_000_000, tokensOutput: 0, model: "claude-sonnet-4-6" })
    expect(collector.finalize("claude-sonnet-4-6").estimatedCostUsd).toBeCloseTo(3, 9)
  })
})
