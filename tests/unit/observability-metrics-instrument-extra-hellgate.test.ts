import { describe, expect, test } from "bun:test"
import type { BudgetLedger, BudgetSnapshot, UsageEvent } from "@/agent/budget-ledger"
import type { PlanQueueStore } from "@/agent/plan-queue"
import { defaultMetricsRegistry } from "@/observability/metrics/index"
import { instrumentBudgetLedger } from "@/observability/metrics/instrument-budget"
import {
  type InstrumentableLspClient,
  instrumentLspClient,
} from "@/observability/metrics/instrument-lsp"
import { instrumentPlanQueue } from "@/observability/metrics/instrument-plan-queue"
import { withFullObservability } from "@/observability/metrics/observability-helper"

// ────────────────────────────────────────────────────────────────────────────
// PlanQueue
// ────────────────────────────────────────────────────────────────────────────
const fakeQueue = (overrides: Partial<PlanQueueStore> = {}): PlanQueueStore =>
  ({
    // ADR-0167: enqueue returns {id, collapsed} (not a bare string).
    enqueue: () => ({ id: "fu-1", collapsed: false }),
    drain: () => [],
    peek: () => [],
    clear: () => 0,
    inspect: () => new Map(),
    ...overrides,
  }) as unknown as PlanQueueStore

describe("instrumentPlanQueue", () => {
  test("enqueue → counter with source/pausedReason/urgent labels", () => {
    const m = defaultMetricsRegistry()
    const q = instrumentPlanQueue(fakeQueue(), m)
    q.enqueue({
      threadId: "t1",
      text: "do X",
      source: "user_keystroke",
      pausedReason: "tool_in_flight",
      arrivedDuringTurn: 3,
      urgent: false,
      metadata: {},
    } as never)
    const c = m.snapshot().find((s) => s.name === "plan_queue.enqueue.total")
    expect(c?.labels.source).toBe("user_keystroke")
    expect(c?.labels.pausedReason).toBe("tool_in_flight")
    expect(c?.labels.urgent).toBe("false")
  })

  test("drain → count_bucket label varies by result size", () => {
    const tests: Array<{ n: number; bucket: string }> = [
      { n: 0, bucket: "0" },
      { n: 1, bucket: "1" },
      { n: 3, bucket: "2-5" },
      { n: 10, bucket: "6+" },
    ]
    for (const { n, bucket } of tests) {
      const m = defaultMetricsRegistry()
      const q = instrumentPlanQueue(
        fakeQueue({ drain: () => Array(n).fill({ id: "x" }) as never }),
        m,
      )
      q.drain("t1", 1)
      const c = m
        .snapshot()
        .find((s) => s.name === "plan_queue.drain.total" && s.labels.count_bucket === bucket)
      expect(c?.value).toBe(1)
    }
  })

  test("clear → counter; peek/inspect pass-through (no metric)", () => {
    const m = defaultMetricsRegistry()
    const q = instrumentPlanQueue(fakeQueue(), m)
    q.clear("t1")
    q.peek("t1")
    q.inspect()
    expect(m.snapshot().filter((s) => s.name === "plan_queue.clear.total").length).toBe(1)
    expect(m.snapshot().filter((s) => s.name.startsWith("plan_queue.peek")).length).toBe(0)
  })

  // ─────────────────────────────────────────────────────────────
  // ADR-0167 — enqueue collapse counter
  // ─────────────────────────────────────────────────────────────

  test("HELL-PQ-NEW-1: collapsed:true → plan_queue.enqueue.collapsed.total increments", () => {
    const m = defaultMetricsRegistry()
    const q = instrumentPlanQueue(
      fakeQueue({ enqueue: () => ({ id: "fu-existing", collapsed: true }) }),
      m,
    )
    q.enqueue({
      threadId: "t1",
      text: "dup",
      source: "user_keystroke",
      pausedReason: "tool_in_flight",
      arrivedDuringTurn: 1,
      urgent: false,
      metadata: {},
    } as never)
    // The collapsed counter fires; the attempt counter also fires.
    const all = m.snapshot()
    const collapsedSeries = all.filter((s) => s.name === "plan_queue.enqueue.collapsed.total")
    expect(collapsedSeries.length).toBeGreaterThan(0)
    const attemptSeries = all.filter((s) => s.name === "plan_queue.enqueue.total")
    expect(attemptSeries.length).toBeGreaterThan(0)
  })

  test("HELL-PQ-NEW-2: collapsed:false → only enqueue.total (no collapsed counter)", () => {
    const m = defaultMetricsRegistry()
    const q = instrumentPlanQueue(
      fakeQueue({ enqueue: () => ({ id: "fu-new", collapsed: false }) }),
      m,
    )
    q.enqueue({
      threadId: "t1",
      text: "fresh",
      source: "user_keystroke",
      pausedReason: "tool_in_flight",
      arrivedDuringTurn: 1,
      urgent: false,
      metadata: {},
    } as never)
    const all = m.snapshot()
    const collapsedSeries = all.filter((s) => s.name === "plan_queue.enqueue.collapsed.total")
    expect(collapsedSeries.length).toBe(0)
    const attemptSeries = all.filter((s) => s.name === "plan_queue.enqueue.total")
    expect(attemptSeries.length).toBeGreaterThan(0)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// BudgetLedger
// ────────────────────────────────────────────────────────────────────────────
const fakeLedger = (overrides: Partial<BudgetLedger> = {}): BudgetLedger =>
  ({
    // ADR-0162: record returns {cost, breaches}; default fake is 0/[].
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

describe("instrumentBudgetLedger", () => {
  test("record → record.total{model}", () => {
    const m = defaultMetricsRegistry()
    const l = instrumentBudgetLedger(fakeLedger(), m)
    l.record({
      model: "claude-opus-4-7",
      inputTokens: 100,
      outputTokens: 50,
      sessionId: "s1",
      at: 1000,
    } as UsageEvent)
    const c = m.snapshot().find((s) => s.name === "budget.record.total")
    expect(c?.labels.model).toBe("claude-opus-4-7")
  })

  test("record returns breaches → breach.total per breach with kind+scope labels", () => {
    const m = defaultMetricsRegistry()
    const l = instrumentBudgetLedger(
      fakeLedger({
        record: () =>
          ({
            cost: 37,
            breaches: [
              { kind: "session-soft", limit: 10, observed: 15, scope: "s1" },
              { kind: "session-hard", limit: 20, observed: 22, scope: "s1" },
            ],
          }) as never,
      }),
      m,
    )
    l.record({ model: "x", inputTokens: 1, outputTokens: 1, sessionId: "s1", at: 0 } as UsageEvent)
    const breaches = m.snapshot().filter((s) => s.name === "budget.breach.total")
    expect(breaches.length).toBe(2)
    const kinds = breaches.map((b) => b.labels.kind).sort()
    expect(kinds).toEqual(["session-hard", "session-soft"])
  })

  test("ADR-0162: record → event.cost_usd histogram with model label", () => {
    const m = defaultMetricsRegistry()
    const l = instrumentBudgetLedger(
      fakeLedger({
        record: () => ({ cost: 0.42, breaches: [] }) as never,
      }),
      m,
    )
    l.record({
      model: "claude-opus-4-7",
      inputTokens: 1,
      outputTokens: 1,
      sessionId: "s1",
      at: 0,
    } as UsageEvent)
    const h = m.snapshot().find((s) => s.name === "budget.event.cost_usd")
    expect(h).toBeDefined()
    expect(h?.labels.model).toBe("claude-opus-4-7")
    // Histogram value: registries vary; assert presence + label, not internal storage.
  })

  test("snapshot/clear/serialize/hydrate pass through (no metric)", () => {
    const m = defaultMetricsRegistry()
    const l = instrumentBudgetLedger(fakeLedger(), m)
    l.snapshot()
    l.clear()
    l.serialize()
    l.hydrate("{}")
    // Only record emits; pass-throughs do not
    expect(m.snapshot().length).toBe(0)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// LspClient
// ────────────────────────────────────────────────────────────────────────────
const fakeLsp = (overrides: Partial<InstrumentableLspClient> = {}): InstrumentableLspClient => ({
  requestCodeActions: async () => [],
  requestFormatting: async () => [],
  requestSignatureHelp: async () => [],
  applyWorkspaceEdit: async () => undefined,
  ...overrides,
})

describe("instrumentLspClient", () => {
  test("each LSP method → request.total{method, ok='true'} + duration_ms", async () => {
    const m = defaultMetricsRegistry()
    const c = instrumentLspClient(fakeLsp(), m)
    await c.requestCodeActions("a.ts", 1, 1)
    await c.requestFormatting("a.ts")
    await c.requestSignatureHelp("a.ts", 1, 1)
    await c.applyWorkspaceEdit({})
    const methods = m
      .snapshot()
      .filter((s) => s.name === "lsp.request.total")
      .map((s) => s.labels.method)
      .sort()
    expect(methods).toEqual(["apply_workspace_edit", "code_action", "formatting", "signature_help"])
    expect(m.snapshot().filter((s) => s.name === "lsp.request.duration_ms").length).toBe(4)
  })

  test("method throws → request.total{ok='false'} + rethrow", async () => {
    const m = defaultMetricsRegistry()
    const c = instrumentLspClient(
      fakeLsp({
        requestCodeActions: async () => {
          throw new Error("boom")
        },
      }),
      m,
    )
    let caught = false
    try {
      await c.requestCodeActions("a.ts", 1, 1)
    } catch {
      caught = true
    }
    expect(caught).toBe(true)
    const c1 = m
      .snapshot()
      .find((s) => s.name === "lsp.request.total" && s.labels.method === "code_action")
    expect(c1?.labels.ok).toBe("false")
  })

  test("non-LSP property on the client → pass-through (Proxy returns verbatim)", async () => {
    const target = { ...fakeLsp(), customField: 42 }
    const c = instrumentLspClient(target as never, defaultMetricsRegistry())
    expect((c as { customField: number }).customField).toBe(42)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// withFullObservability auto helper
// ────────────────────────────────────────────────────────────────────────────
describe("withFullObservability", () => {
  test("empty bag → empty instrumented bag (all undefined)", () => {
    const m = defaultMetricsRegistry()
    const out = withFullObservability({}, { metrics: m })
    expect(out.llmProvider).toBeUndefined()
    expect(out.scheduler).toBeUndefined()
    expect(out.shadowOdb).toBeUndefined()
    expect(out.planQueue).toBeUndefined()
    expect(out.budgetLedger).toBeUndefined()
    expect(out.lspClient).toBeUndefined()
    expect(out.tools).toBeUndefined()
  })

  test("partial bag → only present keys instrumented", () => {
    const m = defaultMetricsRegistry()
    const out = withFullObservability(
      { planQueue: fakeQueue(), budgetLedger: fakeLedger() },
      { metrics: m },
    )
    expect(out.planQueue).toBeDefined()
    expect(out.budgetLedger).toBeDefined()
    expect(out.llmProvider).toBeUndefined()
  })

  test("full bag → all keys wrapped; emission flows through wrappers", async () => {
    const m = defaultMetricsRegistry()
    const out = withFullObservability(
      {
        planQueue: fakeQueue(),
        budgetLedger: fakeLedger(),
        lspClient: fakeLsp(),
      },
      { metrics: m },
    )
    out.planQueue!.enqueue({
      threadId: "t1",
      text: "x",
      source: "user_keystroke",
      pausedReason: "other",
      arrivedDuringTurn: 1,
      urgent: false,
      metadata: {},
    } as never)
    out.budgetLedger!.record({
      model: "x",
      inputTokens: 1,
      outputTokens: 1,
      sessionId: "s",
      at: 0,
    } as UsageEvent)
    await out.lspClient!.requestCodeActions("a.ts", 1, 1)
    const names = m.snapshot().map((s) => s.name)
    expect(names).toContain("plan_queue.enqueue.total")
    expect(names).toContain("budget.record.total")
    expect(names).toContain("lsp.request.total")
  })

  test("prefix override propagates to wrapped metric names", () => {
    const m = defaultMetricsRegistry()
    const out = withFullObservability(
      { planQueue: fakeQueue() },
      { metrics: m, prefixes: { planQueue: "custom_pq" } },
    )
    out.planQueue!.enqueue({
      threadId: "t1",
      text: "x",
      source: "user_keystroke",
      pausedReason: "other",
      arrivedDuringTurn: 1,
      urgent: false,
      metadata: {},
    } as never)
    expect(m.snapshot().some((s) => s.name === "custom_pq.enqueue.total")).toBe(true)
  })
})
