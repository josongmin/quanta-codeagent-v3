/**
 * P1-A-02 — meter/ledger pricing policy divergence (W0.6).
 *
 * Canonical `priceUsage` (no fallback) yields `{pricingKnown:false, totalUsd:0}`
 * for an unknown model. The ledger must consume that eventCost and MUST NOT
 * re-price with the sonnet `safeFallback` for USD enforcement.
 *
 * RED on current HEAD: emitUsage → ledger.record(tokens only) → fallback ~$3
 * for 1M input + $1 session hard breach, while the meter skipped the USD tick.
 */
import { describe, expect, test } from "bun:test"
import { defaultBudgetLedger } from "@/agent/budget-ledger"
import { emitUsage } from "@/agent/loop/emit-helpers"
import { ledgerHardBreachCondition } from "@/agent/loop/stop-conditions"
import type { RunAgentContext } from "@/agent/loop/types"
import type { AgentConfig } from "@/agent/types"
import type { StreamEvent } from "@/llm"
import { MODEL_RATE_CARD, PRICING_VERSION } from "@/observability/pricing"
import { normalizeUsage, priceUsage } from "@/observability/usage-accounting"

const UNKNOWN_MODEL = "mystery-model-99-p1-a-02"
const KNOWN_MODEL = "gpt-5.4"

const usageEv = (
  model: string,
  inputTokens: number,
  outputTokens = 0,
): Extract<StreamEvent, { type: "usage" }> => ({
  type: "usage",
  model,
  inputTokens,
  outputTokens,
})

const stubConfig = (
  ledger: ReturnType<typeof defaultBudgetLedger>,
  sessionId: string,
): AgentConfig =>
  ({
    stream: { emit() {} },
    budgetLedger: ledger,
    sessionId,
  }) as unknown as AgentConfig

const stopCtx = (ledger: ReturnType<typeof defaultBudgetLedger>): RunAgentContext =>
  ({ cfg: { budgetLedger: ledger } }) as unknown as RunAgentContext

describe("P1-A-02 — canonical unknown price is not fallback-enforced", () => {
  test("AUDIT PROBE: 1M-token unknown model + $1 hard cap ⇒ no USD breach via emitUsage", () => {
    const normalized = normalizeUsage({
      model: UNKNOWN_MODEL,
      inputTokens: 1_000_000,
      outputTokens: 0,
    })
    const canonical = priceUsage(normalized, MODEL_RATE_CARD, { pricingVersion: PRICING_VERSION })
    expect(canonical.pricingKnown).toBe(false)
    expect(canonical.totalUsd).toBe(0)

    const ledger = defaultBudgetLedger({ policy: { sessionHardLimit: 1 } })
    emitUsage(
      stubConfig(ledger, "audit-sess"),
      usageEv(UNKNOWN_MODEL, 1_000_000),
      undefined,
      undefined,
      undefined,
    )

    // Display total must not be the sonnet stand-in (~$3). Absence is $0.
    expect(ledger.snapshot().totalCost).toBe(0)
    expect(ledger.hardBreach()).toBeUndefined()
    expect(ledgerHardBreachCondition(stopCtx(ledger), 1)).toBeUndefined()
  })

  test("direct record of canonical unknown eventCost does not enforce the $3 fallback", () => {
    const ledger = defaultBudgetLedger({ policy: { sessionHardLimit: 1 } })
    const canonical = priceUsage(
      normalizeUsage({ model: UNKNOWN_MODEL, inputTokens: 1_000_000, outputTokens: 0 }),
      MODEL_RATE_CARD,
      { pricingVersion: PRICING_VERSION },
    )
    const result = ledger.record({
      model: UNKNOWN_MODEL,
      inputTokens: 1_000_000,
      outputTokens: 0,
      sessionId: "direct-unknown",
      at: 0,
      cost: canonical,
    })
    expect(result.cost).toBe(0)
    expect(result.pricingKnown).toBe(false)
    expect(result.breaches).toEqual([])
    expect(ledger.hardBreach()).toBeUndefined()
  })

  test("known model over the USD cap still breaches and stops", () => {
    const ledger = defaultBudgetLedger({ policy: { sessionHardLimit: 1 } })
    emitUsage(
      stubConfig(ledger, "known-sess"),
      usageEv(KNOWN_MODEL, 1_000_000, 0),
      undefined,
      undefined,
      undefined,
    )
    // gpt-5.4: $2.5 / 1M input > $1
    expect(ledger.snapshot().totalCost).toBeGreaterThan(1)
    expect(ledger.hardBreach()?.kind).toBe("session-hard")
    const stop = ledgerHardBreachCondition(stopCtx(ledger), 1)
    expect(stop?.reason).toBe("budget_exhausted")
  })

  test("token budgets are independent of unknown USD (tokens still tick)", () => {
    const ticks: string[] = []
    const meter = {
      tick(kind: string, amount: number) {
        ticks.push(`${kind}:${amount}`)
      },
    }
    const ledger = defaultBudgetLedger({ policy: { sessionHardLimit: 0.01 } })
    const config = {
      stream: { emit() {} },
      budgetLedger: ledger,
      budgetMeter: meter,
      sessionId: "token-sess",
    } as unknown as AgentConfig
    emitUsage(config, usageEv(UNKNOWN_MODEL, 42, 7), undefined, undefined, undefined)
    expect(ticks).toContain("input_tokens:42")
    expect(ticks).toContain("output_tokens:7")
    expect(ticks.some((t) => t.startsWith("cost_usd:"))).toBe(false)
    expect(ledger.hardBreach()).toBeUndefined()
  })

  test("estimated (fallback, no canonical cost) is displayed but not USD-enforced", () => {
    // Live record without eventCost keeps the historical sonnet display number
    // (HELL-3/HELL-30) but W0.6 forbids enforcing that estimate.
    const ledger = defaultBudgetLedger({ policy: { sessionHardLimit: 1 } })
    const result = ledger.record({
      model: UNKNOWN_MODEL,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      sessionId: "estimated-display",
      at: 0,
    })
    expect(result.cost).toBeCloseTo(18, 6)
    expect(result.pricingKnown).toBe(false)
    expect(ledger.snapshot().totalCost).toBeCloseTo(18, 6)
    expect(ledger.hardBreach()).toBeUndefined()
    expect(ledgerHardBreachCondition(stopCtx(ledger), 1)).toBeUndefined()
  })
})

describe("P1-A-02 — persist/hydrate provenance", () => {
  test("unknown emitUsage round-trips: hydrate does not USD-stop", () => {
    const a = defaultBudgetLedger({ policy: { sessionHardLimit: 1 } })
    emitUsage(
      stubConfig(a, "persist-u"),
      usageEv(UNKNOWN_MODEL, 1_000_000),
      undefined,
      undefined,
      undefined,
    )
    expect(a.hardBreach()).toBeUndefined()
    const blob = a.serialize()
    expect(blob).toContain("unknown")

    const b = defaultBudgetLedger({ policy: { sessionHardLimit: 1 } })
    b.hydrate(blob)
    expect(b.hardBreach()).toBeUndefined()
    expect(b.snapshot().totalCost).toBe(0)
    expect(ledgerHardBreachCondition(stopCtx(b), 1)).toBeUndefined()
  })

  test("known spend persists and still hard-breaches after hydrate", () => {
    const a = defaultBudgetLedger({ policy: { sessionHardLimit: 1 } })
    emitUsage(
      stubConfig(a, "persist-k"),
      usageEv(KNOWN_MODEL, 1_000_000),
      undefined,
      undefined,
      undefined,
    )
    expect(a.hardBreach()?.kind).toBe("session-hard")
    const b = defaultBudgetLedger({ policy: { sessionHardLimit: 1 } })
    b.hydrate(a.serialize())
    expect(b.hardBreach()?.kind).toBe("session-hard")
  })

  test("legacy serialized events without provenance are NOT known (no USD enforce)", () => {
    const legacy = JSON.stringify({
      v: 1,
      events: [
        {
          model: KNOWN_MODEL,
          inputTokens: 1_000_000,
          outputTokens: 0,
          sessionId: "legacy-sess",
          at: 0,
        },
      ],
      firedBreaches: [],
    })
    const ledger = defaultBudgetLedger({ policy: { sessionHardLimit: 1 } })
    ledger.hydrate(legacy)
    // A follow-up known tick would trip if the hydrated $2.5 were treated as known.
    ledger.record({
      model: KNOWN_MODEL,
      inputTokens: 1,
      outputTokens: 0,
      sessionId: "legacy-sess",
      at: 1,
    })
    expect(ledger.hardBreach()).toBeUndefined()
    expect(ledgerHardBreachCondition(stopCtx(ledger), 1)).toBeUndefined()
  })
})
