/**
 * HELLGATE — cross-run cost-ledger PERSISTENCE (the campaign budget headline).
 *
 * persistBudgetLedger wraps the pure in-memory ledger so several runs share one
 * `~/.quanta/budget.json`: hydrate on construct, write-through after each
 * record. This is what makes a multi-run campaign / daemon stop once CUMULATIVE
 * spend (not per-run) crosses the hard cap. No-throw on any fs failure.
 */
import { describe, expect, test } from "bun:test"
import { defaultBudgetLedger } from "@/agent/budget-ledger"
import { type LedgerFs, persistBudgetLedger } from "@/host/runtime/budget-ledger-persist"

/** In-memory fs so the test never touches disk. */
const memFs = (): LedgerFs & { store: Map<string, string> } => {
  const store = new Map<string, string>()
  return {
    store,
    exists: (p) => store.has(p),
    read: (p) => store.get(p) ?? "",
    write: (p, d) => void store.set(p, d),
  }
}

const spend = (usd1mInputMultiplier: number) => ({
  model: "gpt-5.4", // $2.5 / 1M input
  inputTokens: 1_000_000 * usd1mInputMultiplier,
  outputTokens: 0,
  sessionId: "s",
  at: 0,
})

describe("HELLGATE — budget-ledger cross-process persistence", () => {
  test("write-through: record() flushes serialized state to the path", () => {
    const fs = memFs()
    const l = persistBudgetLedger(defaultBudgetLedger(), "/b.json", fs)
    expect(fs.store.has("/b.json")).toBe(false)
    l.record(spend(1))
    expect(fs.store.get("/b.json")).toContain("gpt-5.4")
  })

  test("CAMPAIGN: run B hydrates run A's spend ⇒ cumulative cap trips cross-run", () => {
    const fs = memFs()
    const PATH = "/campaign.json"
    // Run A: $2.5 spent, under a $4 daily cap ⇒ no breach yet.
    const a = persistBudgetLedger(defaultBudgetLedger({ policy: { dailyHardLimit: 4 } }), PATH, fs)
    a.record(spend(1)) // +$2.5
    expect(a.hardBreach()).toBeUndefined()

    // Run B (fresh process): hydrates A's $2.5, then spends $2.5 more ⇒ $5 > $4.
    const b = persistBudgetLedger(defaultBudgetLedger({ policy: { dailyHardLimit: 4 } }), PATH, fs)
    b.record(spend(1)) // cumulative $5 across both runs
    expect(b.hardBreach()?.kind).toBe("daily-hard")
    expect(b.snapshot().totalCost).toBeGreaterThan(4)
  })

  test("absent file ⇒ starts empty (first run), then persists", () => {
    const fs = memFs()
    const l = persistBudgetLedger(defaultBudgetLedger(), "/new.json", fs)
    expect(l.snapshot().events).toBe(0)
    l.record(spend(1))
    expect(l.snapshot().events).toBe(1)
    expect(fs.store.has("/new.json")).toBe(true)
  })

  test("NO-THROW: a write that throws degrades to in-memory (loop never breaks)", () => {
    const throwingFs: LedgerFs = {
      exists: () => false,
      read: () => "",
      write: () => {
        throw new Error("disk full")
      },
    }
    const l = persistBudgetLedger(
      defaultBudgetLedger({ policy: { sessionHardLimit: 1 } }),
      "/x.json",
      throwingFs,
    )
    // record still succeeds in-memory + enforcement still works despite write fail.
    expect(() => l.record(spend(1))).not.toThrow()
    expect(l.hardBreach()?.kind).toBe("session-hard")
  })

  test("NO-THROW: a corrupt/garbage hydrate file ⇒ empty ledger, no throw", () => {
    const fs = memFs()
    fs.store.set("/corrupt.json", "}{not json")
    expect(() => persistBudgetLedger(defaultBudgetLedger(), "/corrupt.json", fs)).not.toThrow()
    const l = persistBudgetLedger(defaultBudgetLedger(), "/corrupt.json", fs)
    expect(l.snapshot().events).toBe(0)
  })

  test("delegates the full surface (snapshot/serialize/hardBreach pass through)", () => {
    const fs = memFs()
    const l = persistBudgetLedger(
      defaultBudgetLedger({ policy: { sessionHardLimit: 1 } }),
      "/d.json",
      fs,
    )
    l.record(spend(1))
    expect(l.snapshot().totalCost).toBeGreaterThan(0)
    expect(typeof l.serialize()).toBe("string")
    expect(l.hardBreach()?.kind).toBe("session-hard")
  })
})
