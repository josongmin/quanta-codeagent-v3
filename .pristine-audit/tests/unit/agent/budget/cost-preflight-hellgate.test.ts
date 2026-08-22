/**
 * HELLGATE — autonomous cost cap L2: pre-flight admission control.
 *
 * L0 catches a cost overrun at the per-turn EPILOGUE (after the model call has
 * already been billed). L2 adds admission control BEFORE the call: if the
 * accumulated cost plus the projected INPUT cost of the next prompt already
 * exceeds the cap, the call is GUARANTEED to breach (output only adds cost), so
 * the loop stops without issuing — saving one guaranteed-breach call.
 *
 * Zero-false-positive contract: the projection uses the input-floor (output=0)
 * and the deterministic `estimateTokens` of the prompt. A breach of the floor
 * is certain regardless of output. With NO cost dial the projection is a pure
 * no-op (byte-identical).
 */

import { describe, expect, test } from "bun:test"
import { BudgetMeter } from "@/agent"
import type { Message } from "@/llm"
import { projectCostPreflight } from "../../../../src/agent/loop/turn-iteration"
import type { AgentConfig } from "../../../../src/agent/types"

describe("HELLGATE L2 — BudgetMeter.wouldExceedCost (pure projection)", () => {
  test("no maxCostUsd dial ⇒ never would-exceed (byte-identical)", () => {
    const m = new BudgetMeter()
    expect(m.wouldExceedCost(1_000_000).exhausted).toBe(false)
  })

  test("projected spend that crosses the cap ⇒ would-exceed with cost_usd kind", () => {
    const m = new BudgetMeter({ dials: { maxCostUsd: 5 } })
    m.tick("cost_usd", 4) // accumulated $4, cap $5
    const ex = m.wouldExceedCost(1.5) // 4 + 1.5 = 5.5 > 5
    expect(ex.exhausted).toBe(true)
    expect(ex.kind).toBe("cost_usd")
    expect(ex.budget).toBe(5)
    expect(ex.observed).toBeCloseTo(5.5, 6)
  })

  test("projected spend that stays at/under the cap ⇒ not would-exceed (strict >)", () => {
    const m = new BudgetMeter({ dials: { maxCostUsd: 5 } })
    m.tick("cost_usd", 4)
    expect(m.wouldExceedCost(1).exhausted).toBe(false) // 4 + 1 = 5, not > 5
    expect(m.wouldExceedCost(0.99).exhausted).toBe(false)
  })

  test("does NOT mutate the meter (pure projection)", () => {
    const m = new BudgetMeter({ dials: { maxCostUsd: 5 } })
    m.tick("cost_usd", 4)
    m.wouldExceedCost(10)
    m.wouldExceedCost(10)
    expect(m.snapshot().costUsd).toBe(4) // unchanged
  })

  test("non-finite / negative projection ⇒ not would-exceed (cannot pre-empt on garbage)", () => {
    const m = new BudgetMeter({ dials: { maxCostUsd: 5 } })
    m.tick("cost_usd", 4)
    expect(m.wouldExceedCost(Number.NaN).exhausted).toBe(false)
    expect(m.wouldExceedCost(Number.POSITIVE_INFINITY).exhausted).toBe(false)
    expect(m.wouldExceedCost(-100).exhausted).toBe(false)
  })

  test("consistent with checkExhausted: projecting 0 mirrors the post-hoc gate", () => {
    const m = new BudgetMeter({ dials: { maxCostUsd: 5 } })
    m.tick("cost_usd", 6) // already over
    // wouldExceedCost(0) ≡ checkExhausted for the cost dial.
    expect(m.wouldExceedCost(0).exhausted).toBe(true)
    expect(m.checkExhausted().kind).toBe("cost_usd")
  })
})

describe("HELLGATE L2 — projectCostPreflight prices the RESOLVED model (no swap FP)", () => {
  // ~10k-token prompt (estimateTokens ≈ chars/4).
  const wmWith = (tokens: number): { snapshot: () => readonly Message[] } => {
    const text = "x".repeat(tokens * 4)
    const messages: Message[] = [{ role: "user", content: [{ type: "text", text }] }]
    return { snapshot: () => messages }
  }
  const cfgWith = (meter: BudgetMeter): AgentConfig =>
    ({ budgetMeter: meter, llm: { model: "claude-opus-4-7" } }) as unknown as AgentConfig

  test("REGRESSION: a cheaper resolved model does NOT trip (the base-model FP fix)", () => {
    // Near the cap. The BASE model (claude-opus-4-7, $15/M in) would over-
    // estimate the floor and trip; the RESOLVED cheaper model must not.
    const meter = new BudgetMeter({ dials: { maxCostUsd: 1 } })
    meter.tick("cost_usd", 0.97)
    const cfg = cfgWith(meter)
    const wm = wmWith(10_000) as never
    // gpt-5.4-nano = $0.2/1M in ⇒ floor = 10k*0.2/1M = $0.002 ⇒ 0.972 < 1 ⇒ no trip.
    expect(projectCostPreflight(cfg, wm, "gpt-5.4-nano")).toBeUndefined()
    // claude-opus-4-7 = $15/1M in ⇒ floor = 10k*15/1M = $0.15 ⇒ 1.12 > 1 ⇒ trips.
    expect(projectCostPreflight(cfg, wm, "claude-opus-4-7")?.exhausted).toBe(true)
  })

  test("no budgetMeter ⇒ undefined regardless of model (byte-identical)", () => {
    const cfg = { llm: { model: "claude-opus-4-7" } } as unknown as AgentConfig
    expect(projectCostPreflight(cfg, wmWith(10_000) as never, "claude-opus-4-7")).toBeUndefined()
  })

  test("unpriced resolved model ⇒ undefined (no pre-flight, mirrors meter best-effort)", () => {
    const meter = new BudgetMeter({ dials: { maxCostUsd: 0.0001 } })
    meter.tick("cost_usd", 0.0001)
    expect(projectCostPreflight(cfgWith(meter), wmWith(10_000) as never, "gpt-5-2")).toBeUndefined()
  })
})
