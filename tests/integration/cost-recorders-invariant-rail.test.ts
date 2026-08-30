/**
 * A0 — the three-recorder invariant rail (precedes every deletion).
 *
 * meter, authority, and ledger each record the SAME emitUsage events under
 * deliberately different policies. This rail freezes the RELATIONSHIP between
 * them so a later change to any one sink fails here by name — it is the
 * regression net that must be GREEN before the legacy feed may be removed.
 *
 * The policies, stated so the numbers below are auditable:
 *   - meter     — enforcement: known-priced spend only; unknown and non-finite
 *                 contribute 0 (a cap must never bill a guess).
 *   - authority — session truth: unknown model admits at $0 with
 *                 pricingKnown:false (visible, never invented); non-finite is
 *                 REJECTED (a broken report must not enter the books).
 *   - ledger    — cross-run policy: unknown model bills the sonnet FALLBACK
 *                 (operator-visible estimate, HELL-3/30); non-finite buckets
 *                 are zeroed by its own contract.
 *
 * So an unknown model is ALLOWED to differ across recorders ($0 runtime vs $3
 * ledger) — the invariant is that the difference is exactly the ledger's
 * declared fallback, nothing else.
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

  // The ledger's own record results carry pricingKnown, so the fallback
  // portion is MEASURED off the recorder under test, not re-derived here.
  let ledgerFallbackUsd = 0
  const origRecord = ledger.record.bind(ledger)
  ;(ledger as { record: typeof ledger.record }).record = (ev) => {
    const res = origRecord(ev)
    if (!res.pricingKnown) ledgerFallbackUsd += res.cost
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
  emit({ model: "mystery-model-99", inputTokens: 1_000_000 }) // meter 0 / authority 0 unpriced / ledger +3
  emit({ model: "claude-sonnet-4-6", inputTokens: Number.NaN }) // meter 0 / authority reject / ledger 0

  return { meter, ledger, authority, ledgerFallbackUsd }
}

describe("A0 — three recorders, one relationship", () => {
  test("per-policy totals land on the declared numbers", () => {
    const { meter, ledger, authority } = runSequence()
    expect(round(meter.snapshot().costUsd)).toBe(4.975)
    expect(round(authority.snapshot().totalUsd)).toBe(4.975)
    expect(round(ledger.snapshot().totalCost)).toBe(7.975)
  })

  test("the recorders differ by EXACTLY the ledger's declared fallback", () => {
    const { meter, ledger, authority, ledgerFallbackUsd } = runSequence()
    expect(round(ledgerFallbackUsd)).toBe(3)
    expect(round(ledger.snapshot().totalCost - ledgerFallbackUsd)).toBe(
      round(meter.snapshot().costUsd),
    )
    expect(round(ledger.snapshot().totalCost - ledgerFallbackUsd)).toBe(
      round(authority.snapshot().totalUsd),
    )
  })

  test("the unknown call is admitted to the authority as unpriced, not invented", () => {
    const { authority } = runSequence()
    const mystery = authority.recent().find((r) => r.usage.model === "mystery-model-99")
    expect(mystery).toBeDefined()
    expect(mystery?.cost.pricingKnown).toBe(false)
    expect(mystery?.cost.totalUsd).toBe(0)
  })

  test("the non-finite event enters NO recorder's totals", () => {
    const { authority, ledger } = runSequence()
    // authority: rejected outright — 4 admitted calls, not 5.
    expect(authority.snapshot().calls).toBe(4)
    // ledger: retained but zero-billed by its own bucket contract.
    expect(ledger.snapshot().events).toBe(5)
    expect(Number.isFinite(ledger.snapshot().totalCost)).toBe(true)
  })
})
