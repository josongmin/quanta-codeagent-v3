import { describe, expect, test } from "bun:test"
import {
  type BudgetLedger,
  type BudgetLedgerOpts,
  DEFAULT_MODEL_PRICING,
  defaultBudgetLedger,
  type ModelPricing,
  type UsageEvent,
} from "@/agent/budget-ledger"
import { buildBudgetBlock } from "@/agent/tier1/budget"

/**
 * Budget ledger — hellgate (ADR-0136).
 *
 * Closed-port DI primitive: token × pricing → $$ + soft/hard breach events at
 * session and daily scope. Hellgate seals the 8 contract clauses + 4 wiring
 * sub-clauses (LRU eviction, hydrate safety, breach debounce, deterministic
 * day boundaries).
 *
 * Sections:
 *   A. Pricing math (5)
 *   B. Aggregation (5)
 *   C. Limits / breaches (8)
 *   D. Persistence (3)
 *   E. LRU cap (2)
 *   F. Tool (3)
 */

const SESSION = "abc-123"

const usageOf = (over: Partial<UsageEvent> = {}): UsageEvent => ({
  model: "claude-opus-4-7",
  inputTokens: 0,
  outputTokens: 0,
  sessionId: SESSION,
  at: 1_000_000,
  ...over,
})

const ledgerOf = (over: BudgetLedgerOpts = {}): BudgetLedger => defaultBudgetLedger(over)

const drainPerModel = (ledger: BudgetLedger, model: string): number =>
  ledger.snapshot().perModel.get(model)?.totalCost ?? 0

// ────────────────────────────────────────────────────────────────────────────
// A. PRICING MATH (5)
// ────────────────────────────────────────────────────────────────────────────
describe("budget-ledger / A. pricing math", () => {
  test("HELL-1: opus 1M in + 1M out = $90", () => {
    const l = ledgerOf()
    l.record(usageOf({ inputTokens: 1_000_000, outputTokens: 1_000_000 }))
    const snap = l.snapshot()
    // 15 (in) + 75 (out) = 90
    expect(snap.totalCost).toBeCloseTo(90, 6)
  })

  test("HELL-2: cached input bills at cache-read rate, not input rate", () => {
    const l = ledgerOf()
    l.record(
      usageOf({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
      }),
    )
    const snap = l.snapshot()
    // opus cacheReadPerM = 1.5
    expect(snap.totalCost).toBeCloseTo(1.5, 6)
  })

  test("HELL-3: unknown model falls back to sonnet pricing and is recorded", () => {
    const l = ledgerOf()
    l.record(
      usageOf({
        model: "mystery-model-99",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
    )
    const snap = l.snapshot()
    // Sonnet fallback: 3 (in) + 15 (out) = 18
    expect(snap.totalCost).toBeCloseTo(18, 6)
    // The event IS recorded under the unknown model name (operator-visible).
    expect(snap.perModel.has("mystery-model-99")).toBe(true)
    expect(snap.events).toBe(1)
  })

  test("HELL-4: zero / negative / NaN tokens yield 0 cost (no NaN, no negative)", () => {
    const l = ledgerOf()
    l.record(usageOf({ inputTokens: 0, outputTokens: 0 }))
    l.record(usageOf({ inputTokens: -100, outputTokens: -200 }))
    l.record(usageOf({ inputTokens: Number.NaN, outputTokens: 1_000_000 }))
    const snap = l.snapshot()
    // Only the third event's output bills (75). NaN input → 0.
    expect(snap.totalCost).toBeCloseTo(75, 6)
    expect(Number.isFinite(snap.totalCost)).toBe(true)
    expect(snap.totalCost).toBeGreaterThanOrEqual(0)
  })

  test("HELL-5: multiple events sum correctly per model", () => {
    const l = ledgerOf()
    l.record(usageOf({ inputTokens: 1_000_000, outputTokens: 0 })) // 15
    l.record(usageOf({ inputTokens: 0, outputTokens: 1_000_000 })) // 75
    l.record(usageOf({ inputTokens: 500_000, outputTokens: 0 })) // 7.5
    expect(drainPerModel(l, "claude-opus-4-7")).toBeCloseTo(97.5, 6)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// B. AGGREGATION (5)
// ────────────────────────────────────────────────────────────────────────────
describe("budget-ledger / B. aggregation", () => {
  test("HELL-6: 3 events same session = 1 per-session entry", () => {
    const l = ledgerOf()
    l.record(usageOf({ inputTokens: 100_000 }))
    l.record(usageOf({ inputTokens: 100_000 }))
    l.record(usageOf({ inputTokens: 100_000 }))
    expect(l.snapshot().perSession.size).toBe(1)
    expect(l.snapshot().perSession.get(SESSION)?.inputTokens).toBe(300_000)
  })

  test("HELL-7: 2 events same UTC day = 1 per-day entry", () => {
    const l = ledgerOf()
    // 2026-05-24 00:00:00 UTC + 00:10:00 UTC
    const base = Date.UTC(2026, 4, 24, 0, 0, 0)
    l.record(usageOf({ at: base, inputTokens: 100_000 }))
    l.record(usageOf({ at: base + 10 * 60_000, inputTokens: 100_000 }))
    expect(l.snapshot().perDay.size).toBe(1)
    expect(l.snapshot().perDay.get("2026-05-24")?.inputTokens).toBe(200_000)
  })

  test("HELL-8: 23:55 + 00:05 UTC = 2 different day entries", () => {
    const l = ledgerOf()
    const before = Date.UTC(2026, 4, 24, 23, 55, 0)
    const after = Date.UTC(2026, 4, 25, 0, 5, 0)
    l.record(usageOf({ at: before }))
    l.record(usageOf({ at: after }))
    const days = [...l.snapshot().perDay.keys()].sort()
    expect(days).toEqual(["2026-05-24", "2026-05-25"])
  })

  test("HELL-9: cross-session and cross-day breakdowns coexist", () => {
    const l = ledgerOf()
    const d1 = Date.UTC(2026, 4, 24, 12, 0, 0)
    const d2 = Date.UTC(2026, 4, 25, 12, 0, 0)
    l.record(usageOf({ sessionId: "s-A", at: d1, inputTokens: 100_000 }))
    l.record(usageOf({ sessionId: "s-B", at: d1, inputTokens: 100_000 }))
    l.record(usageOf({ sessionId: "s-A", at: d2, inputTokens: 100_000 }))
    const snap = l.snapshot()
    expect(snap.perSession.size).toBe(2)
    expect(snap.perDay.size).toBe(2)
  })

  test("HELL-10: totalCost = sum of all events", () => {
    const l = ledgerOf()
    l.record(usageOf({ inputTokens: 1_000_000 })) // 15
    l.record(usageOf({ inputTokens: 1_000_000 })) // 15
    l.record(usageOf({ outputTokens: 1_000_000 })) // 75
    expect(l.snapshot().totalCost).toBeCloseTo(15 + 15 + 75, 6)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// C. LIMITS / BREACHES (8)
// ────────────────────────────────────────────────────────────────────────────
describe("budget-ledger / C. limits & breaches", () => {
  test("HELL-11: no policy → record returns empty array; no breaches", () => {
    const l = ledgerOf()
    const breaches = l.record(usageOf({ inputTokens: 100_000_000 })) // $1500
    expect(breaches).toEqual([])
  })

  test("HELL-12: sessionSoftLimit crossed → 1 session-soft breach", () => {
    const l = ledgerOf({ policy: { sessionSoftLimit: 10 } })
    // 1M input on opus = $15 > $10 cap
    const breaches = l.record(usageOf({ inputTokens: 1_000_000 }))
    expect(breaches).toHaveLength(1)
    expect(breaches[0]?.kind).toBe("session-soft")
    expect(breaches[0]?.scope).toBe(SESSION)
    expect(breaches[0]?.limit).toBe(10)
    expect(breaches[0]?.observed).toBeCloseTo(15, 6)
  })

  test("HELL-13: sessionHardLimit crossed → 1 session-hard breach", () => {
    const l = ledgerOf({ policy: { sessionHardLimit: 5 } })
    const breaches = l.record(usageOf({ inputTokens: 1_000_000 })) // $15
    expect(breaches).toHaveLength(1)
    expect(breaches[0]?.kind).toBe("session-hard")
  })

  test("HELL-14: soft + hard both cross in one record → both in array, [soft, hard] order", () => {
    const l = ledgerOf({ policy: { sessionSoftLimit: 5, sessionHardLimit: 10 } })
    const breaches = l.record(usageOf({ inputTokens: 1_000_000 })) // $15
    expect(breaches).toHaveLength(2)
    expect(breaches[0]?.kind).toBe("session-soft")
    expect(breaches[1]?.kind).toBe("session-hard")
  })

  test("HELL-15: same session over-limit keeps recording without re-firing breach", () => {
    const l = ledgerOf({ policy: { sessionSoftLimit: 5 } })
    const first = l.record(usageOf({ inputTokens: 1_000_000 })) // $15 → fires
    const second = l.record(usageOf({ inputTokens: 1_000_000 })) // $30 → no re-fire
    const third = l.record(usageOf({ inputTokens: 1_000_000 })) // $45 → no re-fire
    expect(first).toHaveLength(1)
    expect(second).toEqual([])
    expect(third).toEqual([])
    // But events accumulate.
    expect(l.snapshot().events).toBe(3)
  })

  test("HELL-16: different sessions track breaches independently", () => {
    const l = ledgerOf({ policy: { sessionSoftLimit: 5 } })
    const a = l.record(usageOf({ sessionId: "s-A", inputTokens: 1_000_000 }))
    const b = l.record(usageOf({ sessionId: "s-B", inputTokens: 1_000_000 }))
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
    expect(a[0]?.scope).toBe("s-A")
    expect(b[0]?.scope).toBe("s-B")
  })

  test("HELL-17: daily soft + hard work analogously", () => {
    const l = ledgerOf({ policy: { dailySoftLimit: 5, dailyHardLimit: 12 } })
    const t = Date.UTC(2026, 4, 24, 12, 0, 0)
    const breaches = l.record(usageOf({ at: t, inputTokens: 1_000_000 })) // $15
    expect(breaches).toHaveLength(2)
    expect(breaches[0]?.kind).toBe("daily-soft")
    expect(breaches[1]?.kind).toBe("daily-hard")
    expect(breaches[0]?.scope).toBe("2026-05-24")
  })

  test("HELL-18: clear({session}) resets that session's breach memory; can re-fire", () => {
    const l = ledgerOf({ policy: { sessionSoftLimit: 5 } })
    const first = l.record(usageOf({ inputTokens: 1_000_000 })) // fires
    expect(first).toHaveLength(1)
    const cleared = l.clear({ session: SESSION })
    expect(cleared).toBe(1)
    const refire = l.record(usageOf({ inputTokens: 1_000_000 })) // fires again
    expect(refire).toHaveLength(1)
    expect(refire[0]?.kind).toBe("session-soft")
  })
})

// ────────────────────────────────────────────────────────────────────────────
// D. PERSISTENCE (3)
// ────────────────────────────────────────────────────────────────────────────
describe("budget-ledger / D. persistence", () => {
  test("HELL-19: serialize returns valid JSON", () => {
    const l = ledgerOf()
    l.record(usageOf({ inputTokens: 100_000, turnId: "t-1" }))
    const s = l.serialize()
    expect(() => JSON.parse(s)).not.toThrow()
    const obj = JSON.parse(s) as { v: number; events: unknown[] }
    expect(obj.v).toBe(1)
    expect(obj.events).toHaveLength(1)
  })

  test("HELL-20: hydrate(serialize()) round-trips — snapshot equals", () => {
    const original = ledgerOf({ policy: { sessionSoftLimit: 5 } })
    original.record(usageOf({ inputTokens: 100_000, turnId: "t-1" }))
    original.record(usageOf({ inputTokens: 1_000_000 })) // fires soft
    const before = original.snapshot()
    const serialized = original.serialize()

    const restored = ledgerOf({ policy: { sessionSoftLimit: 5 } })
    restored.hydrate(serialized)
    const after = restored.snapshot()
    expect(after.totalCost).toBeCloseTo(before.totalCost, 6)
    expect(after.events).toBe(before.events)
    expect(after.perModel.size).toBe(before.perModel.size)
    expect(after.perSession.size).toBe(before.perSession.size)
    expect(after.perDay.size).toBe(before.perDay.size)
    // Breach memory survives — re-recording over-budget event must NOT re-fire.
    const refire = restored.record(usageOf({ inputTokens: 1_000_000 }))
    expect(refire).toEqual([])
  })

  test("HELL-21: hydrate(garbage) resets to empty, no throw", () => {
    const l = ledgerOf()
    l.record(usageOf({ inputTokens: 100_000 }))
    expect(l.snapshot().events).toBe(1)
    expect(() => l.hydrate("this is not json")).not.toThrow()
    expect(l.snapshot().events).toBe(0)

    l.record(usageOf({ inputTokens: 100_000 }))
    expect(() => l.hydrate('{"v":99,"events":[]}')).not.toThrow() // wrong version
    expect(l.snapshot().events).toBe(0)

    l.record(usageOf({ inputTokens: 100_000 }))
    expect(() => l.hydrate('{"v":1,"events":"not an array"}')).not.toThrow()
    expect(l.snapshot().events).toBe(0)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// E. LRU CAP (2)
// ────────────────────────────────────────────────────────────────────────────
describe("budget-ledger / E. LRU cap", () => {
  test("HELL-22: maxEvents=10, record 15 → snapshot.events=10", () => {
    const l = ledgerOf({ maxEvents: 10 })
    for (let i = 0; i < 15; i++) l.record(usageOf({ at: 1_000_000 + i, inputTokens: 100_000 }))
    expect(l.snapshot().events).toBe(10)
  })

  test("HELL-23: LRU drops OLDEST first (the surviving slice is the 5 newest)", () => {
    const l = ledgerOf({ maxEvents: 5 })
    // Distinct sessions so we can verify which survived.
    for (let i = 0; i < 8; i++) {
      l.record(usageOf({ sessionId: `s-${i}`, at: 1_000_000 + i, inputTokens: 100_000 }))
    }
    const sessions = [...l.snapshot().perSession.keys()].sort()
    // Sessions 3..7 should be the survivors (oldest 0,1,2 dropped).
    expect(sessions).toEqual(["s-3", "s-4", "s-5", "s-6", "s-7"])
  })
})

// ────────────────────────────────────────────────────────────────────────────
// F. TOOL (3)
// ────────────────────────────────────────────────────────────────────────────
describe("budget-ledger / F. budget_status tool", () => {
  const runTool = async (
    ledger: BudgetLedger,
    input: { scope?: "all" | "session" | "day"; format?: "compact" | "detailed" } = {},
  ): Promise<string> => {
    const tools = buildBudgetBlock({ budgetLedger: ledger })
    const tool = tools[0]
    if (tool === undefined) throw new Error("expected budget_status tool to be wired")
    let final = ""
    for await (const ev of tool.execute(input, {
      cwd: "/tmp",
      signal: new AbortController().signal,
    })) {
      if (ev.type === "result") final = ev.result.output
    }
    return final
  }

  test("HELL-24: budget_status returns formatted output reflecting snapshot", async () => {
    const ledger = ledgerOf()
    ledger.record(usageOf({ inputTokens: 1_000_000, outputTokens: 1_000_000 }))
    const out = await runTool(ledger)
    expect(out).toContain("Budget:")
    expect(out).toContain("$90.00") // opus 1M+1M = 90
    expect(out).toContain("claude-opus-4-7")
    expect(out).toContain(SESSION)
  })

  test("HELL-25: no ledger wired → tool not in block (factory not invoked)", () => {
    const tools = buildBudgetBlock({})
    expect(tools).toEqual([])
  })

  test("HELL-26: scope='session' / 'day' filters the output", async () => {
    const ledger = ledgerOf()
    const t = Date.UTC(2026, 4, 24, 12, 0, 0)
    ledger.record(usageOf({ at: t, inputTokens: 1_000_000 }))
    const sessionOnly = await runTool(ledger, { scope: "session" })
    expect(sessionOnly).toContain("By session:")
    expect(sessionOnly).not.toContain("By day:")
    expect(sessionOnly).not.toContain("By model:")

    const dayOnly = await runTool(ledger, { scope: "day" })
    expect(dayOnly).toContain("By day:")
    expect(dayOnly).not.toContain("By session:")
    expect(dayOnly).not.toContain("By model:")
  })
})

// Sanity: the default pricing table is exported and frozen — a future
// reviewer can verify the typed surface compiles for downstream callers.
test("smoke: DEFAULT_MODEL_PRICING shape + ModelPricing typing", () => {
  expect(Object.keys(DEFAULT_MODEL_PRICING).length).toBeGreaterThan(0)
  const opus: ModelPricing | undefined = DEFAULT_MODEL_PRICING["claude-opus-4-7"]
  expect(opus?.inputPerM).toBe(15)
})
