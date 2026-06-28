/**
 * HELLGATE — L4b: cross-run cost ledger enforcement.
 *
 * The BudgetLedger (ADR-0136) was fully built but UNWIRED: nothing recorded
 * usage into it and nothing read its breaches, so its session/daily hard cost
 * ceilings could never stop a run. L4b wires it:
 *   - emitUsage records each event into `config.budgetLedger` (default-OFF).
 *   - `BudgetLedger.hardBreach()` surfaces a fired session/daily HARD breach.
 *   - the turn loop stops the run (budget_exhausted) when it fires.
 *
 * Unit half here: `hardBreach()` semantics + the emitUsage record seam. The
 * loop-level anti-theater proof lives in
 * tests/integration/ledger-enforce-loop-e2e.test.ts.
 */
import { describe, expect, test } from "bun:test"
import { defaultBudgetLedger } from "@/agent/budget-ledger"
import type { StreamEvent } from "@/llm"
import { emitUsage } from "../../../../src/agent/loop/emit-helpers"
import type { AgentConfig } from "../../../../src/agent/types"

describe("HELLGATE L4b — BudgetLedger.hardBreach()", () => {
  test("undefined with no policy (pure accountant — never stops)", () => {
    const l = defaultBudgetLedger()
    l.record({ model: "gpt-5.4", inputTokens: 10_000_000, outputTokens: 0, sessionId: "s", at: 0 })
    expect(l.hardBreach()).toBeUndefined()
  })

  test("undefined when only a SOFT limit is crossed (advisory, not a stop)", () => {
    const l = defaultBudgetLedger({ policy: { sessionSoftLimit: 1 } })
    l.record({ model: "gpt-5.4", inputTokens: 1_000_000, outputTokens: 0, sessionId: "s", at: 0 })
    // $2.5 input > $1 soft, but soft never returns from hardBreach.
    expect(l.hardBreach()).toBeUndefined()
  })

  test("fires for session-hard with reconstructed observed >= limit", () => {
    const l = defaultBudgetLedger({ policy: { sessionHardLimit: 1 } })
    l.record({
      model: "gpt-5.4",
      inputTokens: 1_000_000,
      outputTokens: 0,
      sessionId: "sess-A",
      at: 0,
    })
    const b = l.hardBreach()
    expect(b?.kind).toBe("session-hard")
    expect(b?.scope).toBe("sess-A")
    expect(b?.limit).toBe(1)
    expect(b?.observed).toBeGreaterThan(1) // $2.5 input
  })

  test("survives serialize/hydrate (campaign cross-run persistence)", () => {
    const a = defaultBudgetLedger({ policy: { sessionHardLimit: 1 } })
    a.record({ model: "gpt-5.4", inputTokens: 1_000_000, outputTokens: 0, sessionId: "s", at: 0 })
    expect(a.hardBreach()).toBeDefined()
    const blob = a.serialize()
    // A fresh ledger on another box hydrates the prior campaign state...
    const b = defaultBudgetLedger({ policy: { sessionHardLimit: 1 } })
    b.hydrate(blob)
    expect(b.hardBreach()?.kind).toBe("session-hard") // breach memory restored
  })
})

describe("HELLGATE L4b — emitUsage records into the ledger (wiring)", () => {
  const usageEvent = (inTok: number, outTok: number): Extract<StreamEvent, { type: "usage" }> => ({
    type: "usage",
    model: "gpt-5.4",
    inputTokens: inTok,
    outputTokens: outTok,
  })

  test("WIRING: emitUsage feeds config.budgetLedger (not via record() directly)", () => {
    const ledger = defaultBudgetLedger({ policy: { sessionHardLimit: 1 } })
    const config = {
      stream: { emit() {} },
      budgetLedger: ledger,
      sessionId: "wire-sess",
    } as unknown as AgentConfig
    emitUsage(config, usageEvent(1_000_000, 500_000), undefined, undefined, undefined)
    const snap = ledger.snapshot()
    expect(snap.totalCost).toBeGreaterThan(0)
    expect(snap.perSession.get("wire-sess")?.totalCost).toBeGreaterThan(0)
    expect(ledger.hardBreach()?.kind).toBe("session-hard") // $10 > $1 cap
  })

  test("no ledger slot ⇒ emitUsage is a no-op for the ledger (byte-identical)", () => {
    // Just proves the optional-chain path doesn't throw when the slot is absent.
    const config = { stream: { emit() {} } } as unknown as AgentConfig
    expect(() =>
      emitUsage(config, usageEvent(1_000_000, 500_000), undefined, undefined, undefined),
    ).not.toThrow()
  })
})
