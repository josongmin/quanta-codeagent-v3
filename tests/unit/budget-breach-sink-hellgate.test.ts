/**
 * Soft-breach → advisory `budget_breach` AgentEvent sink — hellgate (ALBB-21).
 *
 * The L4 ledger sink in `emitUsage` used to DISCARD the `RecordResult` a
 * `BudgetLedger.record(...)` returns, so a crossed SOFT cap fired no event, no
 * log — the operator never learned they crossed the advisory ceiling. The new
 * sink threads the `RecordResult` through and, on a non-empty `breaches` list,
 * emits ONE `budget_breach` AgentEvent per breach carrying the typed
 * `{severity, scope, observed, limit}` derived verbatim from the `BudgetBreach`.
 *
 * ADVISORY, non-fatal: this NEVER stops the run (the HARD path stops via
 * `ledgerHardBreachCondition`; this sink is pure observability). Default-OFF:
 * no `budgetLedger` ⇒ no `record` ⇒ no breaches ⇒ no emit, byte-identical.
 *
 * RED-ON-INJECTION: an empty `breaches: []` must emit ZERO `budget_breach`
 * events (no false-positive banner); a single-breach result must emit EXACTLY
 * one with the breach's `{scope, observed, limit}` and the derived severity.
 */
import { describe, expect, test } from "bun:test"
import type { BudgetBreach, BudgetLedger, RecordResult } from "@/agent/budget-ledger"
import { emitUsage } from "@/agent/loop/emit-helpers"
import type { AgentConfig } from "@/agent/types"
import type { AgentEvent } from "@/stream"

/** A ledger stub whose `record` returns a scripted `RecordResult`. Every other
 *  method is an inert guard — the sink must consult ONLY `record`'s return. */
const ledgerReturning = (result: RecordResult): BudgetLedger =>
  ({
    record: (): RecordResult => result,
    snapshot: () => {
      throw new Error("snapshot must not be called by the sink")
    },
    clear: () => 0,
    serialize: () => "",
    hydrate: () => undefined,
    hardBreach: () => undefined,
  }) as unknown as BudgetLedger

/** Minimal AgentConfig — `emitUsage` reads `config.stream` + optional
 *  `config.budgetLedger`; all other slots are absent no-ops. */
const stubConfig = (sink: AgentEvent[], ledger: BudgetLedger | undefined): AgentConfig =>
  ({
    stream: {
      emit: (e: AgentEvent): void => {
        sink.push(e)
      },
    },
    ...(ledger !== undefined ? { budgetLedger: ledger } : {}),
  }) as unknown as AgentConfig

const breachEvents = (sink: AgentEvent[]): Extract<AgentEvent, { type: "budget_breach" }>[] =>
  sink.filter(
    (e): e is Extract<AgentEvent, { type: "budget_breach" }> => e.type === "budget_breach",
  )

const usageEv = (
  over: Partial<Extract<AgentEvent, { type: "usage" }>> = {},
): Extract<AgentEvent, { type: "usage" }> => ({
  type: "usage",
  inputTokens: 100,
  outputTokens: 40,
  model: "claude-opus-4-7",
  ...over,
})

const SESSION_SOFT: BudgetBreach = {
  kind: "session-soft",
  limit: 5,
  observed: 7.5,
  scope: "sess-1",
}

describe("ALBB-21 — soft-breach advisory budget_breach sink", () => {
  test("a single soft breach emits EXACTLY one budget_breach with derived {severity,scope,observed,limit}", () => {
    const sink: AgentEvent[] = []
    const ledger = ledgerReturning({ cost: 1.2, breaches: [SESSION_SOFT] })
    emitUsage(stubConfig(sink, ledger), usageEv(), undefined, undefined, undefined)

    const breaches = breachEvents(sink)
    expect(breaches).toHaveLength(1)
    const b = breaches[0]
    if (b === undefined) throw new Error("no budget_breach emitted")
    expect(b.severity).toBe("soft")
    expect(b.scope).toBe("sess-1")
    expect(b.observed).toBe(7.5)
    expect(b.limit).toBe(5)
  })

  test("hard breach derives severity=hard (scope of the breach class survives)", () => {
    const sink: AgentEvent[] = []
    const hard: BudgetBreach = { kind: "daily-hard", limit: 50, observed: 61, scope: "2026-07-09" }
    const ledger = ledgerReturning({ cost: 3, breaches: [hard] })
    emitUsage(stubConfig(sink, ledger), usageEv(), undefined, undefined, undefined)

    const breaches = breachEvents(sink)
    expect(breaches).toHaveLength(1)
    expect(breaches[0]?.severity).toBe("hard")
    expect(breaches[0]?.scope).toBe("2026-07-09")
  })

  test("empty breaches ⇒ ZERO budget_breach events (no false-positive banner)", () => {
    const sink: AgentEvent[] = []
    const ledger = ledgerReturning({ cost: 0.1, breaches: [] })
    emitUsage(stubConfig(sink, ledger), usageEv(), undefined, undefined, undefined)
    expect(breachEvents(sink)).toHaveLength(0)
  })

  test("no budgetLedger ⇒ ZERO budget_breach events (default-OFF byte-identical)", () => {
    const sink: AgentEvent[] = []
    emitUsage(stubConfig(sink, undefined), usageEv(), undefined, undefined, undefined)
    expect(breachEvents(sink)).toHaveLength(0)
    // still emits the ordinary usage event (sink not otherwise disturbed)
    expect(sink.some((e) => e.type === "usage")).toBe(true)
  })

  test("advisory, non-fatal: emitUsage returns void and never throws on a breach", () => {
    const sink: AgentEvent[] = []
    const ledger = ledgerReturning({ cost: 1, breaches: [SESSION_SOFT] })
    expect(() =>
      emitUsage(stubConfig(sink, ledger), usageEv(), undefined, undefined, undefined),
    ).not.toThrow()
  })
})
