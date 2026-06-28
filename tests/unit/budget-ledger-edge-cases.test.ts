/**
 * Edge cases for the cross-run cost ledger: UTC daily-boundary rollover, LRU
 * eviction vs hardBreach, and the cross-PROCESS write-through race (a documented
 * limitation — last serialize wins).
 */
import { describe, expect, test } from "bun:test"
import { defaultBudgetLedger } from "@/agent/budget-ledger"
import { type LedgerFs, persistBudgetLedger } from "@/host/runtime/budget-ledger-persist"

const DAY1 = Date.UTC(2026, 5, 28, 12) // 2026-06-28
const DAY2 = Date.UTC(2026, 5, 29, 12) // 2026-06-29
const spend = (at: number, mult: number, session = "s") => ({
  model: "gpt-5.4",
  inputTokens: 1_000_000 * mult, // $2.5/M ⇒ $2.5 * mult
  outputTokens: 0,
  sessionId: session,
  at,
})

describe("ledger — UTC daily-boundary rollover", () => {
  test("daily-hard cap is PER-DAY: day-1 spend does NOT count against day-2", () => {
    const l = defaultBudgetLedger({ policy: { dailyHardLimit: 4 } })
    l.record(spend(DAY1, 1)) // day1 $2.5  (< $4)
    expect(l.hardBreach()).toBeUndefined()
    l.record(spend(DAY2, 1)) // day2 $2.5  (separate day, < $4)
    expect(l.hardBreach()).toBeUndefined() // day2 alone is under cap
    l.record(spend(DAY2, 1)) // day2 now $5 > $4 ⇒ daily-hard for day2
    const b = l.hardBreach()
    expect(b?.kind).toBe("daily-hard")
    expect(b?.scope).toBe("2026-06-29")
    expect(b?.observed).toBeGreaterThan(4)
  })

  test("per-day aggregates are isolated (day1 total unaffected by day2)", () => {
    const l = defaultBudgetLedger()
    l.record(spend(DAY1, 1))
    l.record(spend(DAY2, 2))
    const snap = l.snapshot()
    expect(snap.perDay.get("2026-06-28")?.totalCost).toBeCloseTo(2.5, 6)
    expect(snap.perDay.get("2026-06-29")?.totalCost).toBeCloseTo(5, 6)
  })
})

describe("ledger — LRU eviction vs hardBreach (observed clamp)", () => {
  test("after the breaching event is evicted, hardBreach observed clamps to >= limit", () => {
    // maxEvents=1: each record evicts the prior. A session-hard fires on event 1,
    // then event 2 (different session) evicts event 1's aggregate, so the live
    // perSession total for the breached scope drops — observed must NOT report
    // below the limit.
    const l = defaultBudgetLedger({ policy: { sessionHardLimit: 1 }, maxEvents: 1 })
    l.record(spend(DAY1, 1, "A")) // $2.5 > $1 ⇒ session-hard fires for "A"
    expect(l.hardBreach()?.kind).toBe("session-hard")
    l.record(spend(DAY1, 1, "B")) // evicts A's event from the live window
    const b = l.hardBreach()
    expect(b?.kind).toBe("session-hard") // breach memory persists (fired set)
    expect(b?.observed).toBeGreaterThanOrEqual(b?.limit ?? 0) // clamp holds
  })
})

describe("ledger — cross-PROCESS write race (documented limitation)", () => {
  const memFs = (): LedgerFs & { store: Map<string, string> } => {
    const store = new Map<string, string>()
    return {
      store,
      exists: (p) => store.has(p),
      read: (p) => store.get(p) ?? "",
      write: (p, d) => void store.set(p, d),
    }
  }

  test("two processes hydrating the SAME empty file ⇒ last-write-wins (lost update)", () => {
    // This is the KNOWN limitation: write-through is not cross-process atomic.
    // Two runs that both start from an empty file each serialize only THEIR own
    // event; whoever writes last clobbers the other. The honest contract:
    // parallel campaigns must serialize budget through the supervisor, not a
    // shared file. (A single sequential run / daemon is race-free.)
    const fs = memFs()
    const PATH = "/race.json"
    const a = persistBudgetLedger(defaultBudgetLedger(), PATH, fs) // hydrates empty
    const b = persistBudgetLedger(defaultBudgetLedger(), PATH, fs) // hydrates empty (before A wrote)
    a.record(spend(DAY1, 1)) // A writes file = {A:$2.5}
    b.record(spend(DAY1, 1)) // B writes file = {B:$2.5} — A's update LOST
    // The file reflects only the last writer's single event, not the sum.
    const reloaded = persistBudgetLedger(defaultBudgetLedger(), PATH, fs)
    expect(reloaded.snapshot().events).toBe(1) // NOT 2 — the race dropped one
  })

  test("SEQUENTIAL runs (hydrate-after-write) accumulate correctly — the supported path", () => {
    const fs = memFs()
    const PATH = "/seq.json"
    const a = persistBudgetLedger(defaultBudgetLedger(), PATH, fs)
    a.record(spend(DAY1, 1)) // writes {A}
    const b = persistBudgetLedger(defaultBudgetLedger(), PATH, fs) // hydrates AFTER A wrote
    b.record(spend(DAY1, 1)) // writes {A, B}
    expect(b.snapshot().events).toBe(2) // both retained — race-free when sequential
  })
})
