/**
 * ADR-0172 hellgate — `emitWiredGauge` on `withFullObservability`. Default-OFF
 * (flag absent) → byte-identical to today (no `observability.wired.total`
 * series in the snapshot). Opt-in mode emits exactly one gauge per
 * `ObservabilityBag` key (7 total) with `{slice: <key>}` label and value
 * `1` (wrapped output defined) or `0` (slice unwired). The gauge ALWAYS
 * reflects truth — `skippedExpected` only silences the operator-facing
 * warning log, never excludes a slice from the gauge.
 *
 * Distinct from the ADR-0169 skipped-warning sibling: that one is the
 * human-facing startup reminder, this one is the machine-readable signal
 * for PromQL alerts (`observability_wired_total{slice="llmProvider"} == 0`).
 *
 * Research grounding (cited in ADR-0172): no SOTA agent exposes per-slice
 * wiring health as a first-class typed introspection surface — Claude
 * Desktop's Sentry/Statsig/growthbook 3-tier stack is enterprise-internal,
 * Cursor's `TurnEndedUpdate` is token accounting (usage, not wiring),
 * Codex emits per-model OTel but no helper-wiring-health gauge. quanta first.
 */

import { describe, expect, test } from "bun:test"
import type { BudgetLedger, BudgetSnapshot } from "@/agent/budget-ledger"
import type { PlanQueueStore } from "@/agent/plan-queue"
import { defaultMetricsRegistry } from "@/observability/metrics/index"
import {
  type ObservabilityBag,
  withFullObservability,
} from "@/observability/metrics/observability-helper"
import type { MetricSnapshot, MetricsRegistry } from "@/observability/metrics/port"

/* ────────────────────────────────────────────────────────────────────────── */
/* Local fakes — mirror the skipped-warning sibling so we don't share          */
/* fixtures across *.test.ts files.                                            */
/* ────────────────────────────────────────────────────────────────────────── */

const fakeQueue = (): PlanQueueStore =>
  ({
    enqueue: () => ({ id: "fu-1", collapsed: false }),
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
  }) as unknown as PlanQueueStore

const fakeLedger = (): BudgetLedger =>
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
    hardBreach: () => undefined,
  }) as unknown as BudgetLedger

const WIRED_METRIC = "observability.wired.total"
const ALL_KEYS: ReadonlyArray<keyof ObservabilityBag> = [
  "llmProvider",
  "scheduler",
  "shadowOdb",
  "planQueue",
  "budgetLedger",
  "lspClient",
  "tools",
] as const

const wiredRows = (snap: ReadonlyArray<MetricSnapshot>) =>
  snap.filter((s) => s.name === WIRED_METRIC)

describe("ADR-0172 withFullObservability — observability.wired.total gauge", () => {
  test("[1] emitWiredGauge absent (default) → no observability.wired.total in snapshot (byte-identical baseline)", () => {
    const m = defaultMetricsRegistry()
    withFullObservability({}, { metrics: m })
    expect(wiredRows(m.snapshot()).length).toBe(0)
  })

  test("[2] emitWiredGauge=true + empty bag → 7 gauges, all value 0, one per slice label", () => {
    const m = defaultMetricsRegistry()
    withFullObservability({}, { metrics: m, emitWiredGauge: true })
    const rows = wiredRows(m.snapshot())
    expect(rows.length).toBe(7)
    for (const r of rows) {
      expect(r.kind).toBe("gauge")
      expect(r.value).toBe(0)
    }
    const seenSlices = new Set(rows.map((r) => r.labels.slice))
    for (const k of ALL_KEYS) {
      expect(seenSlices.has(k)).toBe(true)
    }
  })

  test("[3] emitWiredGauge=true + all 7 wired → 7 gauges, all value 1", () => {
    const m = defaultMetricsRegistry()
    // Proxy-based stub: any method access returns a no-op function. The
    // individual wraps assert these methods exist (e.g. scheduler.poll.bind),
    // so we need an object whose property reads always succeed.
    const anyMethodStub = (): unknown =>
      new Proxy(() => undefined, {
        get: (_t, _p) => anyMethodStub(),
      })
    const bag: ObservabilityBag = {
      llmProvider: anyMethodStub() as never,
      scheduler: anyMethodStub() as never,
      shadowOdb: anyMethodStub() as never,
      planQueue: fakeQueue(),
      budgetLedger: fakeLedger(),
      lspClient: anyMethodStub() as never,
      tools: [],
    }
    withFullObservability(bag, { metrics: m, emitWiredGauge: true })
    const rows = wiredRows(m.snapshot())
    expect(rows.length).toBe(7)
    for (const r of rows) {
      expect(r.value).toBe(1)
    }
  })

  test("[4] emitWiredGauge=true + partial (3 wired, 4 missing) → 3 gauges=1, 4 gauges=0, labels distinguish correctly", () => {
    const m = defaultMetricsRegistry()
    const bag: ObservabilityBag = {
      planQueue: fakeQueue(),
      budgetLedger: fakeLedger(),
      tools: [],
    }
    withFullObservability(bag, { metrics: m, emitWiredGauge: true })
    const rows = wiredRows(m.snapshot())
    expect(rows.length).toBe(7)
    const bySlice = new Map(rows.map((r) => [r.labels.slice, r.value]))
    expect(bySlice.get("planQueue")).toBe(1)
    expect(bySlice.get("budgetLedger")).toBe(1)
    expect(bySlice.get("tools")).toBe(1)
    expect(bySlice.get("llmProvider")).toBe(0)
    expect(bySlice.get("scheduler")).toBe(0)
    expect(bySlice.get("shadowOdb")).toBe(0)
    expect(bySlice.get("lspClient")).toBe(0)
  })

  test("[5] gauge label slice values match the 7 keys of ObservabilityBag exactly (no drift, no extras)", () => {
    const m = defaultMetricsRegistry()
    withFullObservability({}, { metrics: m, emitWiredGauge: true })
    const rows = wiredRows(m.snapshot())
    const labels = rows.map((r) => r.labels.slice).sort()
    const expected = [...ALL_KEYS].sort()
    expect(labels).toEqual(expected)
  })

  test("[6] skippedExpected does NOT exclude slices from gauge — gauge always reflects truth (separation from ADR-0169 warning concern)", () => {
    const m = defaultMetricsRegistry()
    withFullObservability(
      {},
      {
        metrics: m,
        emitWiredGauge: true,
        // Even with llmProvider in skippedExpected, the gauge must STILL emit
        // value=0 for it. skippedExpected only silences the warning log; the
        // machine-readable gauge is a separate concern.
        warnOnSkipped: true,
        skippedExpected: new Set<keyof ObservabilityBag>(["llmProvider"]),
        warn: () => {
          /* suppress for this test — focus is gauge behavior */
        },
      },
    )
    const rows = wiredRows(m.snapshot())
    expect(rows.length).toBe(7)
    const llmRow = rows.find((r) => r.labels.slice === "llmProvider")
    expect(llmRow).toBeDefined()
    expect(llmRow?.value).toBe(0) // still emitted as 0 — truth, not silenced
  })

  test("[7] metrics.gauge throws → swallowed; subsequent slice gauges are still attempted (continue-loop)", () => {
    // Build a throwing-on-first-call registry that succeeds on subsequent calls.
    const recorded: Array<{ name: string; value: number; labels?: Record<string, string> }> = []
    let throwOnNext = true
    const m: MetricsRegistry = {
      increment: () => {},
      observe: () => {},
      gauge: (name, value, labels) => {
        if (throwOnNext) {
          throwOnNext = false
          throw new Error("first gauge call throws")
        }
        recorded.push({ name, value, ...(labels !== undefined ? { labels } : {}) })
      },
      snapshot: () => [],
      reset: () => {},
      flush: async () => {},
    }
    withFullObservability({}, { metrics: m, emitWiredGauge: true })
    // First call threw → 6 successful recordings (7 keys total, 1 thrown).
    expect(recorded.length).toBe(6)
    // All recorded ones must be the wired metric.
    for (const r of recorded) {
      expect(r.name).toBe(WIRED_METRIC)
      expect(r.value).toBe(0)
    }
  })

  test("[8] custom opts.prefixes does NOT affect observability.wired.total name (meta-metric about the helper, not a sliced subsystem)", () => {
    const m = defaultMetricsRegistry()
    withFullObservability(
      {},
      {
        metrics: m,
        emitWiredGauge: true,
        prefixes: {
          llm: "custom_llm",
          subagent: "custom_subagent",
          shadow: "custom_shadow",
          planQueue: "custom_pq",
          budget: "custom_budget",
          lsp: "custom_lsp",
          tool: "custom_tool",
        },
      },
    )
    const rows = wiredRows(m.snapshot())
    expect(rows.length).toBe(7)
    // No row name should contain any custom prefix.
    for (const r of rows) {
      expect(r.name).toBe(WIRED_METRIC)
      expect(r.name.includes("custom_")).toBe(false)
    }
  })
})
