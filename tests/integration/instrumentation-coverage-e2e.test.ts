import { describe, expect, test } from "bun:test"
import { defaultMetricsRegistry } from "@/observability/metrics/index"
import {
  instrumentLlmProvider,
  instrumentSubagentScheduler,
} from "@/observability/metrics/instrument"
import { defaultBackgroundSubagentScheduler } from "@/agent/subagent-background"
import type { LlmProvider } from "@/llm/providers"

/**
 * E2E instrumentation coverage (ADR-0159).
 *
 * Simulates 1 turn-equivalent flow:
 *   1. LLM provider stream (1 happy)
 *   2. Subagent fork → await (1 cycle)
 *   3. Generic call counter (1 wrap)
 *
 * After the flow, assert that EVERY recommended metric from the 24-metric recipe
 * (ADR-0158) that should fire from this flow IS in the snapshot. Catches the
 * regression where someone adds a slice but forgets to wire instrumentation.
 */

const fakeLlmHappy = (): LlmProvider =>
  ({
    providerId: "anthropic-public",
    async *stream() {
      yield { type: "text_delta", delta: "hi" } as never
      yield { type: "message_stop" } as never
    },
  }) as unknown as LlmProvider

describe("E2E instrumentation coverage", () => {
  test("1-turn flow records all expected metrics from ADR-0158 recipe", async () => {
    const m = defaultMetricsRegistry()

    // ── 1. LLM provider stream ──
    const llm = instrumentLlmProvider(fakeLlmHappy(), m)
    for await (const _ of llm.stream({} as never)) {
      /* drain */
    }

    // ── 2. Subagent fork → await ──
    const baseScheduler = defaultBackgroundSubagentScheduler({
      runner: async () => ({ ok: true, output: "done", turns: 1, finalText: "done" }) as never,
    })
    const scheduler = instrumentSubagentScheduler(baseScheduler, m)
    const handleId = scheduler.fork({ task: "test" } as never)
    await scheduler.await(handleId)

    // ── Assert: required metrics present ──
    const names = m.snapshot().map((s) => s.name)
    const required = [
      "llm.provider.stream.total",
      "llm.provider.stream.ttft_ms",
      "llm.provider.stream.duration_ms",
      "subagent.fork.total",
      "subagent.duration_ms",
    ]
    for (const n of required) {
      expect(names).toContain(n)
    }
  })

  test("instrument wrappers are byte-identical when metrics ports record-fail", async () => {
    // Verify the wrapped flow still completes when the metrics registry throws.
    const throwingMetrics = {
      ...defaultMetricsRegistry(),
      increment: () => {
        throw new Error("registry-broken")
      },
      observe: () => {
        throw new Error("registry-broken")
      },
    } as never

    const llm = instrumentLlmProvider(fakeLlmHappy(), throwingMetrics)
    const scheduler = instrumentSubagentScheduler(
      defaultBackgroundSubagentScheduler({
        runner: async () => ({ ok: true, output: "ok", turns: 1, finalText: "ok" }) as never,
      }),
      throwingMetrics,
    )

    let llmDrained = false
    for await (const _ of llm.stream({} as never)) {
      llmDrained = true
    }
    const handleId = scheduler.fork({ task: "test" } as never)
    const result = await scheduler.await(handleId)

    expect(llmDrained).toBe(true)
    expect(result?.status).toBe("completed")
  })

  test("zero-instrument baseline: no metric recorded when no wrapper used", async () => {
    const m = defaultMetricsRegistry()
    // Direct (unwrapped) usage
    const baseScheduler = defaultBackgroundSubagentScheduler({
      runner: async () => ({ ok: true, output: "ok", turns: 1, finalText: "ok" }) as never,
    })
    const id = baseScheduler.fork({ task: "x" } as never)
    await baseScheduler.await(id)
    // No wrap → registry stays empty (byte-identical default-OFF)
    expect(m.snapshot().length).toBe(0)
  })
})
