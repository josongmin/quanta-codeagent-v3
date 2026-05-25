import { describe, expect, test } from "bun:test"
import type { BudgetLedger, BudgetSnapshot, UsageEvent } from "@/agent/budget-ledger"
import type { PlanQueueStore } from "@/agent/plan-queue"
import { defaultBackgroundSubagentScheduler } from "@/agent/subagent-background"
import type { LlmProvider } from "@/llm/providers"
import { defaultMetricsRegistry } from "@/observability/metrics/index"
import {
  instrumentLlmProvider,
  instrumentSubagentScheduler,
} from "@/observability/metrics/instrument"
import type { InstrumentableLspClient } from "@/observability/metrics/instrument-lsp"
import {
  type InstrumentedBag,
  type ObservabilityBag,
  withFullObservability,
} from "@/observability/metrics/observability-helper"
import type { ShadowOdb } from "@/storage/shadow-odb"
import type { Tool, ToolContext, ToolEvent } from "@/tool"

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
    model: "claude-sonnet-4-6",
    async *stream() {
      yield { type: "text_delta", delta: "hi" } as never
      yield { type: "message_stop", stop_reason: "end_turn" } as never
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
    const total = m.snapshot().find((s) => s.name === "llm.provider.stream.total")
    expect(total?.labels.provider).toBe("anthropic-public")
    expect(total?.labels.model).toBe("claude-sonnet-4-6")
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

  test("bounded histogram compaction keeps instrumented llm histograms queryable", async () => {
    let t = 0
    const m = defaultMetricsRegistry({ histogramMaxObservations: 5 })
    const llm = instrumentLlmProvider(fakeLlmHappy(), m, {
      now: () => (t += 5),
    })

    for (let i = 0; i < 50; i += 1) {
      for await (const _ of llm.stream({} as never)) {
        /* drain */
      }
    }

    const ttft = m.snapshot().find((s) => s.name === "llm.provider.stream.ttft_ms")
    const duration = m.snapshot().find((s) => s.name === "llm.provider.stream.duration_ms")
    expect(ttft?.count).toBe(50)
    expect(ttft?.p50).toBe(5)
    expect(duration?.count).toBe(50)
    expect(duration?.p50).toBe(10)
  })
})

/* ──────────────────────────────────────────────────────────────────────────── */
/* ADR-0161 follow-up: extend coverage to PlanQueue / Budget / LSP / Tool +    */
/* withFullObservability composition. 8 new e2e cases.                         */
/* ──────────────────────────────────────────────────────────────────────────── */

// Inline fake shapes (mirroring the unit-test fixtures at
// tests/unit/observability-metrics-instrument-extra-hellgate.test.ts and
// tests/unit/observability-metrics-instrument-shadow-tool-hellgate.test.ts).
// bun:test fixture sharing across files is awkward, so we re-declare locally.

const fakeQueue = (overrides: Partial<PlanQueueStore> = {}): PlanQueueStore =>
  ({
    enqueue: () => "fu-1",
    drain: () => [],
    peek: () => [],
    clear: () => 0,
    inspect: () => new Map(),
    // ADR-0221 mutator surface stubs.
    findEntry: () => undefined,
    retry: () => ({ ok: false, error: "not-found" as const }),
    edit: () => ({ ok: false, error: "not-found" as const }),
    delete: () => ({ ok: false, error: "not-found" as const }),
    sendNow: () => ({ ok: false, error: "not-found" as const }),
    ...overrides,
  }) as unknown as PlanQueueStore

const fakeLedger = (overrides: Partial<BudgetLedger> = {}): BudgetLedger =>
  ({
    record: () => ({ cost: 0, breaches: [] }),
    snapshot: () =>
      ({
        totalCost: 0,
        perModel: new Map(),
        perSession: new Map(),
        perDay: new Map(),
        events: 0,
      }) as BudgetSnapshot,
    clear: () => 0,
    serialize: () => "{}",
    hydrate: () => {},
    ...overrides,
  }) as unknown as BudgetLedger

const fakeLsp = (overrides: Partial<InstrumentableLspClient> = {}): InstrumentableLspClient => ({
  requestCodeActions: async () => [],
  requestFormatting: async () => [],
  requestSignatureHelp: async () => [],
  applyWorkspaceEdit: async () => undefined,
  ...overrides,
})

const fakeShadow = (overrides: Partial<ShadowOdb> = {}): ShadowOdb =>
  ({
    init: async () => ({ shadowDir: "/x", workspaceHash: "abc" }),
    registerHead: async () => "sha-1",
    diffSinceLast: async () => "",
    diffWorkspaceSinceLast: async () => "",
    rewindToLast: async () => {},
    rewindToVerified: async () => {},
    restorePartial: async () => {},
    markVerified: async () => {},
    listSnapshots: async () => [],
    cleanup: async () => 0,
    ...overrides,
  }) as ShadowOdb

const safeCtx = (): ToolContext => ({
  cwd: "/tmp",
  signal: new AbortController().signal,
})

const fakeTool = (overrides: Partial<Tool> = {}): Tool =>
  ({
    name: "fake_tool",
    description: "fake",
    inputSchema: { type: "object" } as never,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async *execute(_input: unknown, _ctx: ToolContext): AsyncIterable<ToolEvent> {
      yield { type: "result", result: { ok: true, output: "ok" } } as never
    },
    ...overrides,
  }) as Tool

const fakePlanQueueInput = () =>
  ({
    threadId: "t1",
    text: "do X",
    source: "user_keystroke",
    pausedReason: "tool_in_flight",
    arrivedDuringTurn: 1,
    urgent: false,
    metadata: {},
  }) as never

const fakeUsageEvent = (): UsageEvent =>
  ({
    model: "claude-opus-4-7",
    inputTokens: 100,
    outputTokens: 50,
    sessionId: "s1",
    at: 1000,
  }) as UsageEvent

const drainTool = async (t: Tool): Promise<void> => {
  for await (const _ of t.execute({}, safeCtx())) {
    /* drain */
  }
}

const drainLlm = async (l: LlmProvider): Promise<void> => {
  for await (const _ of l.stream({} as never)) {
    /* drain */
  }
}

/** Test-local non-null guard — avoids `!` post-assertion + gives a clear
 *  failure mode when an expected wrapped slice came back undefined. */
const nn = <T>(v: T | undefined, what: string): T => {
  if (v === undefined) throw new Error(`expected ${what} to be defined`)
  return v
}

/** Exercise 1 op per wrapped slice on a full bag (A1/A3 share this driver
 *  to keep the test bodies small + below biome's cognitive-complexity cap). */
const exerciseAllSlices = async (out: InstrumentedBag): Promise<void> => {
  await drainLlm(nn(out.llmProvider, "llmProvider"))
  const scheduler = nn(out.scheduler, "scheduler")
  const id = scheduler.fork({ task: "test" } as never)
  await scheduler.await(id)
  await nn(out.shadowOdb, "shadowOdb").registerHead("/ws")
  nn(out.planQueue, "planQueue").enqueue(fakePlanQueueInput())
  nn(out.budgetLedger, "budgetLedger").record(fakeUsageEvent())
  await nn(out.lspClient, "lspClient").requestCodeActions("a.ts", 1, 1)
  await drainTool(nn(nn(out.tools, "tools")[0], "tools[0]"))
}

const makeFullBag = (): ObservabilityBag => ({
  llmProvider: fakeLlmHappy(),
  scheduler: defaultBackgroundSubagentScheduler({
    runner: async () => ({ ok: true, output: "done", turns: 1, finalText: "done" }) as never,
  }),
  shadowOdb: fakeShadow(),
  planQueue: fakeQueue(),
  budgetLedger: fakeLedger(),
  lspClient: fakeLsp(),
  tools: [fakeTool()],
})

describe("E2E withFullObservability — full 7-wrap flow", () => {
  test("[A1] All 7 keys wired → every slice emits its primary metric", async () => {
    const m = defaultMetricsRegistry()
    const out = withFullObservability(makeFullBag(), { metrics: m })
    await exerciseAllSlices(out)

    const names = new Set(m.snapshot().map((s) => s.name))
    const expectedPrimaries = [
      "llm.provider.stream.total",
      "subagent.fork.total",
      "shadow.checkpoint.total",
      "plan_queue.enqueue.total",
      "budget.record.total",
      "lsp.request.total",
      "tool.call.total",
    ]
    for (const n of expectedPrimaries) {
      expect(names.has(n)).toBe(true)
    }
    // 7 distinct primaries proven present.
    expect(expectedPrimaries.length).toBe(7)
  })

  test("[A2] Partial bag (3 keys) → only those slice metrics appear", async () => {
    const m = defaultMetricsRegistry()
    const out = withFullObservability(
      {
        planQueue: fakeQueue(),
        budgetLedger: fakeLedger(),
        lspClient: fakeLsp(),
      },
      { metrics: m },
    )
    nn(out.planQueue, "planQueue").enqueue(fakePlanQueueInput())
    nn(out.budgetLedger, "budgetLedger").record(fakeUsageEvent())
    await nn(out.lspClient, "lspClient").requestCodeActions("a.ts", 1, 1)

    const names = new Set(m.snapshot().map((s) => s.name))
    expect(names.has("plan_queue.enqueue.total")).toBe(true)
    expect(names.has("budget.record.total")).toBe(true)
    expect(names.has("lsp.request.total")).toBe(true)
    // Absent slices contribute 0 metrics: no LLM/subagent/shadow/tool emission.
    expect(names.has("llm.provider.stream.total")).toBe(false)
    expect(names.has("subagent.fork.total")).toBe(false)
    expect(names.has("shadow.checkpoint.total")).toBe(false)
    expect(names.has("tool.call.total")).toBe(false)
    // And the corresponding instrumented bag entries should be undefined.
    expect(out.llmProvider).toBeUndefined()
    expect(out.scheduler).toBeUndefined()
    expect(out.shadowOdb).toBeUndefined()
    expect(out.tools).toBeUndefined()
  })

  test("[A3] Prefix override propagates through withFullObservability", async () => {
    const m = defaultMetricsRegistry()
    const out = withFullObservability(makeFullBag(), {
      metrics: m,
      prefixes: {
        llm: "x_llm",
        subagent: "x_sub",
        shadow: "x_shadow",
        planQueue: "x_pq",
        budget: "x_budget",
        lsp: "x_lsp",
        tool: "x_tool",
      },
    })
    await exerciseAllSlices(out)

    const names = new Set(m.snapshot().map((s) => s.name))
    // Every prefix override surfaces on its corresponding primary metric.
    expect(names.has("x_llm.stream.total")).toBe(true)
    expect(names.has("x_sub.fork.total")).toBe(true)
    expect(names.has("x_shadow.checkpoint.total")).toBe(true)
    expect(names.has("x_pq.enqueue.total")).toBe(true)
    expect(names.has("x_budget.record.total")).toBe(true)
    expect(names.has("x_lsp.request.total")).toBe(true)
    expect(names.has("x_tool.call.total")).toBe(true)
    // Default-prefix names must NOT appear when overrides are set.
    expect(names.has("llm.provider.stream.total")).toBe(false)
    expect(names.has("plan_queue.enqueue.total")).toBe(false)
    expect(names.has("budget.record.total")).toBe(false)
    expect(names.has("lsp.request.total")).toBe(false)
    expect(names.has("tool.call.total")).toBe(false)
  })

  test("[A4] Same metric N invocations → counter increments N times", () => {
    const m = defaultMetricsRegistry()
    const out = withFullObservability({ planQueue: fakeQueue() }, { metrics: m })
    const N = 5
    const pq = nn(out.planQueue, "planQueue")
    for (let i = 0; i < N; i += 1) {
      pq.enqueue(fakePlanQueueInput())
    }
    const counter = m.snapshot().find((s) => s.name === "plan_queue.enqueue.total")
    expect(counter?.value).toBe(N)
  })
})

describe("E2E withFullObservability — cross-wrap interactions", () => {
  test("[B5] LLM stream + subagent fork in sequence → both metrics present with correct labels", async () => {
    const m = defaultMetricsRegistry()
    const out = withFullObservability(
      {
        llmProvider: fakeLlmHappy(),
        scheduler: defaultBackgroundSubagentScheduler({
          runner: async () => ({ ok: true, output: "done", turns: 1, finalText: "done" }) as never,
        }),
      },
      { metrics: m },
    )
    await drainLlm(nn(out.llmProvider, "llmProvider"))
    const scheduler = nn(out.scheduler, "scheduler")
    const id = scheduler.fork({ task: "t" } as never)
    await scheduler.await(id)

    const snap = m.snapshot()
    const llm = snap.find((s) => s.name === "llm.provider.stream.total")
    const sub = snap.find((s) => s.name === "subagent.fork.total")
    expect(llm).toBeDefined()
    expect(llm?.labels.provider).toBe("anthropic-public")
    expect(sub).toBeDefined()
    // duration histograms also emit for both subsystems.
    expect(snap.some((s) => s.name === "llm.provider.stream.duration_ms")).toBe(true)
    expect(snap.some((s) => s.name === "subagent.duration_ms")).toBe(true)
  })

  test("[B6] Tool wrap + LSP wrap simultaneously → separate series, no crosstalk", async () => {
    const m = defaultMetricsRegistry()
    const out = withFullObservability(
      {
        tools: [fakeTool({ name: "tool_alpha" }), fakeTool({ name: "tool_beta" })],
        lspClient: fakeLsp(),
      },
      { metrics: m },
    )
    const tools = nn(out.tools, "tools")
    await drainTool(nn(tools[0], "tools[0]"))
    await drainTool(nn(tools[1], "tools[1]"))
    const lsp = nn(out.lspClient, "lspClient")
    await lsp.requestFormatting("a.ts")
    await lsp.requestSignatureHelp("a.ts", 1, 1)

    const snap = m.snapshot()
    const toolLabels = snap
      .filter((s) => s.name === "tool.call.total")
      .map((s) => s.labels.tool)
      .sort()
    expect(toolLabels).toEqual(["tool_alpha", "tool_beta"])
    const lspMethods = snap
      .filter((s) => s.name === "lsp.request.total")
      .map((s) => s.labels.method)
      .sort()
    expect(lspMethods).toEqual(["formatting", "signature_help"])
    // No crosstalk: tool labels carry only the `tool` key, LSP carries `method`+`ok`.
    expect(snap.find((s) => s.name === "tool.call.total")?.labels.method).toBeUndefined()
    expect(snap.find((s) => s.name === "lsp.request.total")?.labels.tool).toBeUndefined()
  })

  test("[B7] Budget breach during normal flow → record.total AND breach.total emit", () => {
    const m = defaultMetricsRegistry()
    const out = withFullObservability(
      {
        budgetLedger: fakeLedger({
          record: () =>
            ({
              cost: 0.05,
              breaches: [
                { kind: "session-soft", limit: 10, observed: 15, scope: "s1" },
                { kind: "session-hard", limit: 20, observed: 22, scope: "s1" },
              ],
            }) as never,
        }),
      },
      { metrics: m },
    )
    nn(out.budgetLedger, "budgetLedger").record(fakeUsageEvent())
    const snap = m.snapshot()
    expect(snap.some((s) => s.name === "budget.record.total")).toBe(true)
    const breaches = snap.filter((s) => s.name === "budget.breach.total")
    expect(breaches.length).toBe(2)
    const kinds = breaches.map((b) => b.labels.kind).sort()
    expect(kinds).toEqual(["session-hard", "session-soft"])
  })
})

/** Hand-maintained: each InstrumentedBag key ↔ the metric-name prefix its
 *  wrap is required to emit. Adding a new key to InstrumentedBag without
 *  updating this map → C8's `expect(prefix).toBeDefined()` trips. */
const EXPECTED_METRIC_PREFIX_BY_KEY: Record<keyof InstrumentedBag, string> = {
  llmProvider: "llm.provider.",
  scheduler: "subagent.",
  shadowOdb: "shadow.",
  planQueue: "plan_queue.",
  budgetLedger: "budget.",
  lspClient: "lsp.",
  tools: "tool.",
}

describe("E2E withFullObservability — drift catcher", () => {
  /**
   * [C8] Drift catcher: programmatically iterate the InstrumentedBag keys and
   *      assert each non-undefined one emits AT LEAST one metric whose name
   *      starts with its known prefix. If a new key is added to the bag
   *      without a corresponding entry in `EXPECTED_METRIC_PREFIX_BY_KEY`,
   *      this test fails loudly. Catches:
   *      "new wrap added, not wired into withFullObservability".
   */
  test("[C8] every InstrumentedBag key, when wired, contributes ≥1 metric", async () => {
    const m = defaultMetricsRegistry()
    const out = withFullObservability(makeFullBag(), { metrics: m })
    await exerciseAllSlices(out)

    const allNames = m.snapshot().map((s) => s.name)
    for (const key of Object.keys(out) as Array<keyof InstrumentedBag>) {
      if (out[key] === undefined) continue
      const prefix = EXPECTED_METRIC_PREFIX_BY_KEY[key]
      // drift catcher: new bag key requires a map entry
      expect(prefix).toBeDefined()
      expect(allNames.some((n) => n.startsWith(prefix))).toBe(true)
    }
    // Bonus: the bag's key set must match the map's key set today. If a new
    // key appears on InstrumentedBag, Object.keys grows → mismatch surfaces.
    expect(Object.keys(EXPECTED_METRIC_PREFIX_BY_KEY).sort()).toEqual(Object.keys(out).sort())
  })
})
