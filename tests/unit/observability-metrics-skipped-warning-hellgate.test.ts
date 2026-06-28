/**
 * ADR-0169 hellgate — `warnOnSkipped` / `skippedExpected` / `warn` port on
 * `withFullObservability`. Default-OFF (warnOnSkipped absent) → byte-identical
 * to today (no log emission). Opt-in mode produces ONE combined warning per
 * construction listing every bag key whose value is `undefined` AND not in
 * the `skippedExpected` allowlist. The `warn` port is injectable so tests
 * (and production sinks) don't touch `console.warn`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { BudgetLedger, BudgetSnapshot } from "@/agent/budget-ledger"
import type { PlanQueueStore } from "@/agent/plan-queue"
import { defaultMetricsRegistry } from "@/observability/metrics/index"
import {
  type ObservabilityBag,
  withFullObservability,
} from "@/observability/metrics/observability-helper"

/* ────────────────────────────────────────────────────────────────────────── */
/* Local fakes — mirror the fixtures used by the sibling extra-hellgate suite */
/* so we don't import from another *.test.ts file (bun:test fixture sharing   */
/* across files is awkward).                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

const fakeQueue = (): PlanQueueStore =>
  ({
    enqueue: () => "fu-1",
    drain: () => [],
    peek: () => [],
    clear: () => 0,
    inspect: () => new Map(),
    // ADR-0221 mutator surface stubs (cast keeps test as `as unknown`).
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

/** Capture-warn port: tests push into this array instead of console.warn. */
const makeCaptureWarn = (): { calls: string[]; warn: (msg: string) => void } => {
  const calls: string[] = []
  return { calls, warn: (msg) => calls.push(msg) }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* console.warn restore — only the default-sink case touches the real one.   */
/* ────────────────────────────────────────────────────────────────────────── */
let originalConsoleWarn: typeof console.warn
beforeEach(() => {
  // biome-ignore lint/suspicious/noConsole: test must save/restore the default sink (ADR-0169)
  originalConsoleWarn = console.warn
})
afterEach(() => {
  console.warn = originalConsoleWarn
})

describe("ADR-0169 withFullObservability — skipped-slice warning", () => {
  test("[1] warnOnSkipped omitted (default) → captured warn array stays empty even when all 7 keys undefined", () => {
    const m = defaultMetricsRegistry()
    const cap = makeCaptureWarn()
    const out = withFullObservability({}, { metrics: m, warn: cap.warn })
    // 0 calls — default is silent.
    expect(cap.calls.length).toBe(0)
    // And the bag is still all-undefined (pass-through unchanged).
    expect(out.llmProvider).toBeUndefined()
    expect(out.scheduler).toBeUndefined()
    expect(out.shadowOdb).toBeUndefined()
    expect(out.planQueue).toBeUndefined()
    expect(out.budgetLedger).toBeUndefined()
    expect(out.lspClient).toBeUndefined()
    expect(out.tools).toBeUndefined()
  })

  test("[2] warnOnSkipped=true + all 7 keys undefined → warn called ONCE with combined message listing all 7 keys", () => {
    const m = defaultMetricsRegistry()
    const cap = makeCaptureWarn()
    withFullObservability({}, { metrics: m, warnOnSkipped: true, warn: cap.warn })
    expect(cap.calls.length).toBe(1)
    const msg = cap.calls[0] ?? ""
    // 7 keys listed somewhere in the message
    for (const k of [
      "llmProvider",
      "scheduler",
      "shadowOdb",
      "planQueue",
      "budgetLedger",
      "lspClient",
      "tools",
    ]) {
      expect(msg.includes(k)).toBe(true)
    }
    // And the count prefix says 7.
    expect(msg.includes("7 slice(s) unwired")).toBe(true)
    // And the actionable hint is included.
    expect(msg.includes("skippedExpected")).toBe(true)
  })

  test("[3] warnOnSkipped=true + 3 keys wired + 4 undefined → warn lists exactly the 4 missing keys", () => {
    const m = defaultMetricsRegistry()
    const cap = makeCaptureWarn()
    const bag: ObservabilityBag = {
      planQueue: fakeQueue(),
      budgetLedger: fakeLedger(),
      tools: [],
    }
    withFullObservability(bag, { metrics: m, warnOnSkipped: true, warn: cap.warn })
    expect(cap.calls.length).toBe(1)
    const msg = cap.calls[0] ?? ""
    // Listed:
    for (const k of ["llmProvider", "scheduler", "shadowOdb", "lspClient"]) {
      expect(msg.includes(k)).toBe(true)
    }
    // NOT listed (these are wired):
    for (const k of ["planQueue", "budgetLedger", "tools"]) {
      // Use a delimiter-aware check so "planQueue" inside a longer name can't false-pass —
      // the message uses ", " join so look for surrounded form OR `: ${k}` / `${k},` boundaries.
      const surrounded =
        msg.includes(`: ${k},`) ||
        msg.includes(`, ${k},`) ||
        msg.includes(`, ${k}.`) ||
        msg.includes(`: ${k}.`)
      expect(surrounded).toBe(false)
    }
    expect(msg.includes("4 slice(s) unwired")).toBe(true)
  })

  test("[4] warnOnSkipped=true + skippedExpected=Set([llmProvider, scheduler]) → those 2 NOT in warning; other missing keys still listed", () => {
    const m = defaultMetricsRegistry()
    const cap = makeCaptureWarn()
    withFullObservability(
      {},
      {
        metrics: m,
        warnOnSkipped: true,
        skippedExpected: new Set<keyof ObservabilityBag>(["llmProvider", "scheduler"]),
        warn: cap.warn,
      },
    )
    expect(cap.calls.length).toBe(1)
    const msg = cap.calls[0] ?? ""
    // 5 remaining keys all listed.
    for (const k of ["shadowOdb", "planQueue", "budgetLedger", "lspClient", "tools"]) {
      expect(msg.includes(k)).toBe(true)
    }
    // Excluded by allowlist — confirm absent via delimiter-aware match.
    for (const k of ["llmProvider", "scheduler"]) {
      const surrounded =
        msg.includes(`: ${k},`) ||
        msg.includes(`, ${k},`) ||
        msg.includes(`, ${k}.`) ||
        msg.includes(`: ${k}.`)
      expect(surrounded).toBe(false)
    }
    expect(msg.includes("5 slice(s) unwired")).toBe(true)
  })

  test("[5] warnOnSkipped=true + ALL missing keys in skippedExpected → warn NOT called (everything intentional)", () => {
    const m = defaultMetricsRegistry()
    const cap = makeCaptureWarn()
    withFullObservability(
      {},
      {
        metrics: m,
        warnOnSkipped: true,
        skippedExpected: new Set<keyof ObservabilityBag>([
          "llmProvider",
          "scheduler",
          "shadowOdb",
          "planQueue",
          "budgetLedger",
          "lspClient",
          "tools",
        ]),
        warn: cap.warn,
      },
    )
    expect(cap.calls.length).toBe(0)
  })

  test("[6] custom warn port → ours called; console.warn NOT touched", () => {
    // Spy on console.warn — if it gets called, the test fails.
    let consoleCalls = 0
    console.warn = () => {
      consoleCalls += 1
    }
    const m = defaultMetricsRegistry()
    const cap = makeCaptureWarn()
    withFullObservability({}, { metrics: m, warnOnSkipped: true, warn: cap.warn })
    expect(cap.calls.length).toBe(1)
    expect(consoleCalls).toBe(0)
  })
})
