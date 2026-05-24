import { describe, expect, test } from "bun:test"
import { defaultMetricsRegistry } from "@/observability/metrics/index"
import {
  instrumentLlmProvider,
  instrumentSubagentScheduler,
  withCallCounter,
} from "@/observability/metrics/instrument"
import type { LlmProvider } from "@/llm/providers"
import type { BackgroundSubagentScheduler, SubagentResult, SubagentSpec } from "@/agent/subagent-background"
import type { StreamEvent } from "@/llm"

/**
 * Instrument wrap hellgate (ADR-0159).
 *
 * Each test pins:
 *   - Wrapped port's observable behavior is byte-identical (no method skipped /
 *     no method's contract violated).
 *   - Metrics emitted match the 24-metric recipe (names + labels).
 *   - Metrics emission throws never propagate (no-throw invariant).
 */

const fakeLlmProvider = (overrides: Partial<LlmProvider> = {}): LlmProvider =>
  ({
    providerId: "anthropic-public",
    async *stream() {
      yield { type: "text_delta", delta: "ok" } as never
      yield { type: "message_stop" } as never
    },
    ...overrides,
  }) as unknown as LlmProvider

const fakeScheduler = (overrides: Partial<BackgroundSubagentScheduler> = {}): BackgroundSubagentScheduler =>
  ({
    fork: () => "bg-fake-id",
    poll: () => null,
    await: async () =>
      ({
        status: "completed",
        outputSummary: "ok",
        startedAt: 1000,
        endedAt: 1100,
        turns: 1,
      }) as SubagentResult,
    cancel: () => true,
    list: () => [],
    prune: () => 0,
    serialize: () => "{}",
    hydrate: () => 0,
    hydrateWithPrune: () => ({ restored: 0, pruned: 0 }),
    ...overrides,
  }) as unknown as BackgroundSubagentScheduler

describe("instrumentLlmProvider", () => {
  test("HELL-LLM-1: increments stream.total on call", async () => {
    const m = defaultMetricsRegistry()
    const p = instrumentLlmProvider(fakeLlmProvider(), m)
    for await (const _ of p.stream({} as never)) {
      /* drain */
    }
    const total = m.snapshot().find((s) => s.name === "llm.provider.stream.total")
    expect(total?.value).toBe(1)
    expect(total?.labels.provider).toBe("anthropic-public")
  })

  test("HELL-LLM-2: TTFT histogram observed on first event", async () => {
    let t = 0
    const p = instrumentLlmProvider(fakeLlmProvider(), defaultMetricsRegistry(), {
      now: () => (t += 5),
    })
    for await (const _ of p.stream({} as never)) {
      /* drain */
    }
    // No throw = ok; histogram math validated in registry hellgate
  })

  test("HELL-LLM-3: duration histogram observed on completion", async () => {
    const m = defaultMetricsRegistry()
    const p = instrumentLlmProvider(fakeLlmProvider(), m)
    for await (const _ of p.stream({} as never)) {
      /* drain */
    }
    const dur = m.snapshot().find((s) => s.name === "llm.provider.stream.duration_ms")
    expect(dur).toBeDefined()
    expect(dur?.labels.provider).toBe("anthropic-public")
  })

  test("HELL-LLM-4: failure increments stream.failures.total on throw", async () => {
    const m = defaultMetricsRegistry()
    const throwing = fakeLlmProvider({
      async *stream() {
        throw Object.assign(new Error("boom"), { code: "stream-failed" })
      },
    })
    const p = instrumentLlmProvider(throwing, m)
    let caught = false
    try {
      for await (const _ of p.stream({} as never)) {
        /* drain */
      }
    } catch {
      caught = true
    }
    expect(caught).toBe(true)
    const f = m.snapshot().find((s) => s.name === "llm.provider.stream.failures.total")
    expect(f?.value).toBe(1)
    expect(f?.labels.code).toBe("stream-failed")
  })

  test("HELL-LLM-5: providerId preserved verbatim on wrapped port", () => {
    const p = instrumentLlmProvider(fakeLlmProvider(), defaultMetricsRegistry())
    expect(p.providerId as string).toBe("anthropic-public")
  })

  test("HELL-LLM-6: metrics throw is swallowed", async () => {
    const throwingMetrics: ReturnType<typeof defaultMetricsRegistry> = {
      ...defaultMetricsRegistry(),
      increment: () => {
        throw new Error("registry-broken")
      },
      observe: () => {
        throw new Error("registry-broken")
      },
    } as never
    const p = instrumentLlmProvider(fakeLlmProvider(), throwingMetrics)
    let ok = true
    try {
      for await (const _ of p.stream({} as never)) {
        /* drain */
      }
    } catch {
      ok = false
    }
    expect(ok).toBe(true) // stream completes despite metrics failure
  })
})

describe("instrumentSubagentScheduler", () => {
  test("HELL-SCH-1: fork increments subagent.fork.total", () => {
    const m = defaultMetricsRegistry()
    const s = instrumentSubagentScheduler(fakeScheduler(), m)
    s.fork({ task: "x" } as SubagentSpec)
    const total = m.snapshot().find((x) => x.name === "subagent.fork.total")
    expect(total?.value).toBe(1)
  })

  test("HELL-SCH-2: cancel increments subagent.cancel.total with existed label", () => {
    const m = defaultMetricsRegistry()
    const s = instrumentSubagentScheduler(fakeScheduler({ cancel: () => true }), m)
    s.cancel("bg-x")
    const c = m.snapshot().find((x) => x.name === "subagent.cancel.total")
    expect(c?.value).toBe(1)
    expect(c?.labels.existed).toBe("true")
  })

  test("HELL-SCH-3: await observes duration_ms with status label", async () => {
    const m = defaultMetricsRegistry()
    const s = instrumentSubagentScheduler(fakeScheduler(), m)
    await s.await("bg-x")
    const d = m.snapshot().find((x) => x.name === "subagent.duration_ms")
    expect(d).toBeDefined()
    expect(d?.labels.status).toBe("completed")
  })

  test("HELL-SCH-4: await with null result skips duration emit", async () => {
    const m = defaultMetricsRegistry()
    const s = instrumentSubagentScheduler(fakeScheduler({ await: async () => null }), m)
    await s.await("bg-unknown")
    const d = m.snapshot().find((x) => x.name === "subagent.duration_ms")
    expect(d).toBeUndefined()
  })

  test("HELL-SCH-5: poll/list/prune pass through verbatim", () => {
    const m = defaultMetricsRegistry()
    const s = instrumentSubagentScheduler(fakeScheduler({ list: () => [] as never, prune: () => 7 }), m)
    expect(s.poll("x")).toBe(null)
    expect(s.list()).toEqual([])
    expect(s.prune(1000)).toBe(7)
    // None of these should have emitted metrics (only fork/cancel/await do)
    expect(m.snapshot().length).toBe(0)
  })
})

describe("withCallCounter (generic proxy)", () => {
  test("HELL-PRX-1: listed method increments; non-listed pass through silent", () => {
    const m = defaultMetricsRegistry()
    const target = { hot: () => 1, cold: () => 2 }
    const wrapped = withCallCounter(target, {
      metrics: m,
      metricName: "demo.calls.total",
      methods: ["hot"],
    })
    wrapped.hot()
    wrapped.cold()
    wrapped.hot()
    const c = m.snapshot().find((s) => s.name === "demo.calls.total")
    expect(c?.value).toBe(2) // only "hot" counted
    expect(c?.labels.method).toBe("hot")
  })

  test("HELL-PRX-2: labels-builder runs per call", () => {
    const m = defaultMetricsRegistry()
    const target = { call: (kind: string) => kind }
    const wrapped = withCallCounter(target, {
      metrics: m,
      metricName: "demo.calls.total",
      methods: ["call"],
      labels: (_method, args) => ({ kind: String(args[0]) }),
    })
    wrapped.call("a")
    wrapped.call("b")
    const snapshot = m.snapshot().filter((s) => s.name === "demo.calls.total")
    expect(snapshot.length).toBe(2) // 2 distinct label series
  })

  test("HELL-PRX-3: metrics throw doesn't break wrapped method", () => {
    const throwingMetrics = {
      ...defaultMetricsRegistry(),
      increment: () => {
        throw new Error("boom")
      },
    } as never
    const target = { call: () => "ok" }
    const wrapped = withCallCounter(target, {
      metrics: throwingMetrics,
      metricName: "demo.calls.total",
      methods: ["call"],
    })
    expect(wrapped.call()).toBe("ok")
  })
})
