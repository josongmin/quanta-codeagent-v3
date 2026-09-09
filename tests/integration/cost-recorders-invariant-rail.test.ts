/**
 * A0 — the three-recorder invariant rail (precedes every deletion).
 *
 * meter, authority, and ledger each record the SAME emitUsage events under
 * P1-A-02: ledger consumes canonical `eventCost` and does not re-price
 * unknown models with a sonnet fallback. Unknown spend is $0 everywhere
 * (meter enforcement, authority unpriced, ledger unknown provenance).
 *
 * The policies:
 *   - meter     — enforcement: known-priced spend only; unknown and non-finite
 *                 contribute 0 (a cap must never bill a guess).
 *   - authority — session truth: unknown model admits at $0 with
 *                 pricingKnown:false (visible, never invented); non-finite is
 *                 REJECTED (a broken report must not enter the books).
 *   - ledger    — same canonical cost as emitUsage; unknown is not billed as
 *                 a fallback estimate (G-F15 / P1-A-02).
 */
import { describe, expect, test } from "bun:test"
import { BudgetMeter } from "@/agent/budget/meter"
import { defaultBudgetLedger } from "@/agent/budget-ledger"
import { emitUsage } from "@/agent/loop/emit-helpers"
import type { AgentConfig } from "@/agent/types"
import type { StreamEvent } from "@/llm"
import { createUsageAccounting } from "@/observability/usage-accounting"

type UsageEv = Extract<StreamEvent, { type: "usage" }>

const round = (n: number) => Math.round(n * 1e6) / 1e6

const runSequence = () => {
  const meter = new BudgetMeter({})
  const ledger = defaultBudgetLedger()
  const authority = createUsageAccounting()
  const config = {
    llm: { stream: async function* () {} },
    registry: { get: () => undefined, specs: () => [], isReadOnly: () => true },
    stream: { emit: () => undefined },
    permission: { mode: "acceptEdits" },
    messages: [],
    system: "t",
    cwd: process.cwd(),
    maxTurns: 1,
    signal: new AbortController().signal,
    sessionId: "rail",
    budgetMeter: meter,
    budgetLedger: ledger,
    usageAccounting: authority,
  } as unknown as AgentConfig

  let ledgerUnknownUsd = 0
  const origRecord = ledger.record.bind(ledger)
  ;(ledger as { record: typeof ledger.record }).record = (ev) => {
    const res = origRecord(ev)
    if (!res.pricingKnown) ledgerUnknownUsd += res.cost
    return res
  }

  const emit = (ev: Partial<UsageEv> & { model: string }) =>
    emitUsage(
      config,
      { type: "usage", inputTokens: 0, outputTokens: 0, ...ev } as UsageEv,
      undefined,
      undefined,
      undefined,
    )

  emit({ model: "claude-sonnet-4-6", inputTokens: 1_000_000 }) // +3.000 everywhere
  emit({ model: "gpt-5.4", inputTokens: 1_000_000, cacheReadTokens: 400_000 }) // +1.600 (carve)
  emit({ model: "claude-sonnet-4-6", cacheCreationTokens: 100_000 }) // +0.375 (write)
  emit({ model: "mystery-model-99", inputTokens: 1_000_000 }) // meter 0 / authority 0 unpriced / ledger 0
  emit({ model: "claude-sonnet-4-6", inputTokens: Number.NaN }) // meter 0 / authority reject / ledger 0

  return { meter, ledger, authority, ledgerUnknownUsd }
}

describe("A0 — three recorders, one relationship", () => {
  test("per-policy totals land on the declared numbers", () => {
    const { meter, ledger, authority } = runSequence()
    expect(round(meter.snapshot().costUsd)).toBe(4.975)
    expect(round(authority.snapshot().totalUsd)).toBe(4.975)
    expect(round(ledger.snapshot().totalCost)).toBe(4.975)
  })

  test("unknown is not billed as a ledger fallback", () => {
    const { meter, ledger, authority, ledgerUnknownUsd } = runSequence()
    expect(round(ledgerUnknownUsd)).toBe(0)
    expect(round(ledger.snapshot().totalCost)).toBe(round(meter.snapshot().costUsd))
    expect(round(ledger.snapshot().totalCost)).toBe(round(authority.snapshot().totalUsd))
  })

  test("the unknown call is admitted to the authority as unpriced, not invented", () => {
    const { authority } = runSequence()
    const mystery = authority.recent().find((r) => r.usage.model === "mystery-model-99")
    expect(mystery).toBeDefined()
    expect(mystery?.cost.pricingKnown).toBe(false)
    expect(mystery?.cost.totalUsd).toBe(0)
    expect(authority.snapshot().unpricedCalls).toBe(1)
    expect(authority.snapshot().byModel.get("mystery-model-99")?.unpricedCalls).toBe(1)
  })

  test("the non-finite event enters NO recorder's totals", () => {
    const { authority, ledger } = runSequence()
    expect(authority.snapshot().calls).toBe(4)
    expect(ledger.snapshot().events).toBe(5)
    expect(Number.isFinite(ledger.snapshot().totalCost)).toBe(true)
  })
})
