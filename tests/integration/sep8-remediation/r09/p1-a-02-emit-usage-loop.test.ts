/**
 * P1-A-02 integration: emitUsage fans the same canonical eventCost into meter
 * + ledger, and ledgerHardBreachCondition observes that provenance.
 *
 * Complements the real-loop e2e (known model still USD-stops; unknown does not).
 */
import { describe, expect, test } from "bun:test"
import { defaultBudgetLedger } from "@/agent/budget-ledger"
import { emitUsage } from "@/agent/loop/emit-helpers"
import { ledgerHardBreachCondition } from "@/agent/loop/stop-conditions"
import type { RunAgentContext } from "@/agent/loop/types"
import type { AgentConfig } from "@/agent/types"
import type { StreamEvent } from "@/llm"

const usage = (
  model: string,
  inputTokens: number,
  outputTokens: number,
): Extract<StreamEvent, { type: "usage" }> => ({
  type: "usage",
  model,
  inputTokens,
  outputTokens,
})

describe("P1-A-02 integration — emitUsage cross-sink stop policy", () => {
  test("unknown model + hard limit below sonnet fallback ⇒ no budget_exhausted", () => {
    const ledger = defaultBudgetLedger({ policy: { sessionHardLimit: 1 } })
    const config = {
      stream: { emit() {} },
      budgetLedger: ledger,
      sessionId: "int-unknown",
    } as unknown as AgentConfig
    // 1M in + 1M out at sonnet fallback would be $18. Canonical unknown is $0.
    emitUsage(
      config,
      usage("budget-ledger-test-model", 1_000_000, 1_000_000),
      undefined,
      undefined,
      undefined,
    )
    expect(ledger.snapshot().totalCost).toBe(0)
    expect(ledger.hardBreach()).toBeUndefined()
    const finish = ledgerHardBreachCondition(
      { cfg: { budgetLedger: ledger } } as unknown as RunAgentContext,
      2,
    )
    expect(finish).toBeUndefined()
  })

  test("known model over budget ⇒ ledgerHardBreachCondition returns budget_exhausted", () => {
    const ledger = defaultBudgetLedger({ policy: { sessionHardLimit: 2 } })
    const config = {
      stream: { emit() {} },
      budgetLedger: ledger,
      sessionId: "int-known",
    } as unknown as AgentConfig
    // claude-sonnet-4-6: 200k in ($0.6) + 200k out ($3) = $3.6 > $2
    emitUsage(config, usage("claude-sonnet-4-6", 200_000, 200_000), undefined, undefined, undefined)
    expect(ledger.snapshot().totalCost).toBeGreaterThan(2)
    expect(ledger.hardBreach()?.kind).toBe("session-hard")
    const finish = ledgerHardBreachCondition(
      { cfg: { budgetLedger: ledger } } as unknown as RunAgentContext,
      1,
    )
    expect(finish?.reason).toBe("budget_exhausted")
    expect(finish?.turns).toBe(1)
  })
})
