/**
 * HELLGATE — autonomous-safety cost cap (L0: accurate per-event cost accounting).
 *
 * The `maxCostUsd` dial (batch=$5 / daemon=$3 / ci-bot=$2 in BUDGET_PRESETS)
 * was DECLARED but INERT: `BudgetMeter` priced cost from a token-only `costFn`
 * that no production caller ever injected, so `snapshot().costUsd` was pinned
 * at 0 and the `maxCostUsd` gate in `checkExhausted` could NEVER trip — an
 * unbounded autonomous spend hole.
 *
 * The fix routes the per-event model id (`ev.model`, available only at the
 * stream-usage site) through the pricing SSOT (`@/observability` `costUsd`) and
 * ticks the resulting USD into the meter from the loop's `emitUsage` — the SAME
 * single seam that already ticks input/output tokens.
 *
 * These are the RED proofs: before the wiring they fail (cost stays 0 / cap
 * never trips); after, the cap is live. The wiring-proof drives the REAL
 * `emitUsage` (never `meter.tick("cost_usd", …)` directly) so the test cannot
 * pass without the production seam being wired (anti-theater).
 */

import { describe, expect, test } from "bun:test"
import { BUDGET_PRESETS, BudgetMeter } from "@/agent"
import type { StreamEvent } from "@/llm"
import { costUsd, PRICING_VERSION } from "@/observability"
import type { DecisionEvent } from "@/stream"
import type { BudgetExhaustion } from "../../../../src/agent/budget"
import { emitBudgetExhaustedDecision } from "../../../../src/agent/decision-emit-phase3"
import { emitUsage } from "../../../../src/agent/loop/emit-helpers"
import type { AgentConfig } from "../../../../src/agent/types"

/** Minimal AgentConfig carrying only the fields `emitUsage` reads. */
const configWithMeter = (meter: BudgetMeter | undefined): AgentConfig =>
  ({
    stream: { emit() {} },
    ...(meter !== undefined ? { budgetMeter: meter } : {}),
  }) as unknown as AgentConfig

/** A terminal `usage` stream event for a priced model. */
const usageEvent = (
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens?: number,
): Extract<StreamEvent, { type: "usage" }> => ({
  type: "usage",
  model,
  inputTokens,
  outputTokens,
  ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
})

/** Drive the production seam: one terminal usage event through `emitUsage`. */
const feedUsage = (meter: BudgetMeter, ev: Extract<StreamEvent, { type: "usage" }>): void => {
  emitUsage(configWithMeter(meter), ev, undefined, undefined, undefined)
}

describe("HELLGATE cost cap — L0 accurate cost accounting", () => {
  test("WIRING-PROOF: emitUsage accrues real USD cost into the meter (not 0)", () => {
    const meter = new BudgetMeter({ dials: { maxCostUsd: 1000 } })
    // gpt-5.4 = $2.5/1M in + $15/1M out ⇒ 1M+1M = $17.5
    feedUsage(meter, usageEvent("gpt-5.4", 1_000_000, 1_000_000))
    const expected = costUsd("gpt-5.4", 1_000_000, 1_000_000) ?? -1
    expect(expected).toBeGreaterThan(0)
    expect(meter.snapshot().costUsd).toBeCloseTo(expected, 6)
  })

  test("KEYSTONE: maxCostUsd actually trips via the emitUsage seam (was inert)", () => {
    const meter = new BudgetMeter({ dials: { maxCostUsd: 1 } })
    feedUsage(meter, usageEvent("gpt-5.4", 1_000_000, 1_000_000)) // $17.5 >> $1
    const ex = meter.checkExhausted()
    expect(ex.exhausted).toBe(true)
    expect(ex.kind).toBe("cost_usd")
    expect(ex.budget).toBe(1)
    expect(ex.observed).toBeGreaterThan(1)
  })

  test("ACCUMULATES across events (delta semantics, mirrors token tick)", () => {
    const meter = new BudgetMeter({ dials: { maxCostUsd: 30 } })
    feedUsage(meter, usageEvent("gpt-5.4", 1_000_000, 1_000_000)) // +$17.5
    expect(meter.checkExhausted().exhausted).toBe(false) // 17.5 < 30
    feedUsage(meter, usageEvent("gpt-5.4", 1_000_000, 1_000_000)) // +$17.5 ⇒ $35
    expect(meter.checkExhausted().exhausted).toBe(true) // 35 > 30
  })

  test("CONTROL: no maxCostUsd dial ⇒ enforcement byte-identical (never trips)", () => {
    const meter = new BudgetMeter() // no dials at all
    feedUsage(meter, usageEvent("gpt-5.4", 5_000_000, 5_000_000)) // huge spend
    expect(meter.checkExhausted().exhausted).toBe(false)
  })

  test("UNKNOWN MODEL: unpriced model ⇒ cost stays 0 (best-effort, no false trip)", () => {
    const meter = new BudgetMeter({ dials: { maxCostUsd: 0.000001 } })
    // `gpt-5-2` is a lane alias absent from the price TABLE ⇒ costUsd null.
    expect(costUsd("gpt-5-2", 1_000_000, 1_000_000)).toBeNull()
    feedUsage(meter, usageEvent("gpt-5-2", 1_000_000, 1_000_000))
    expect(meter.snapshot().costUsd).toBe(0)
    expect(meter.checkExhausted().exhausted).toBe(false)
  })

  test("cache-read pricing flows through (openai carve-out, not double-count)", () => {
    const meter = new BudgetMeter({ dials: { maxCostUsd: 1000 } })
    feedUsage(meter, usageEvent("gpt-5.4", 1_000_000, 100_000, 800_000))
    const expected = costUsd("gpt-5.4", 1_000_000, 100_000, 800_000) ?? -1
    expect(meter.snapshot().costUsd).toBeCloseTo(expected, 6)
  })

  test("pricing SSOT is versioned (audit/reproducibility anchor)", () => {
    expect(PRICING_VERSION).toMatch(/^pricing\./)
  })

  test("STRUCTURAL: declared BUDGET_PRESETS cost dial is now ENFORCED end-to-end", () => {
    // Close the declared↔enforced loop: the autonomous presets DECLARE a
    // maxCostUsd ($5/$3/$2) and the SAME value, fed through the real emitUsage
    // seam, must actually trip. Guards against silent re-inerting (e.g. a
    // future refactor dropping the cost tick) AND against the dial being
    // removed from the presets.
    for (const mode of ["batch", "daemon", "ci-bot"] as const) {
      const cap = BUDGET_PRESETS[mode].maxCostUsd
      expect(cap).toBeGreaterThan(0) // dial present in the preset
      const meter = new BudgetMeter({ dials: BUDGET_PRESETS[mode] })
      // Accrue priced spend past the cap through the production seam.
      let guard = 0
      while (!meter.checkExhausted().exhausted && guard < 100) {
        feedUsage(meter, usageEvent("gpt-5.4", 1_000_000, 1_000_000)) // +$17.5
        guard++
      }
      const ex = meter.checkExhausted()
      expect(ex.exhausted).toBe(true)
      expect(ex.kind).toBe("cost_usd")
      expect(ex.budget).toBe(cap)
    }
  })
})

describe("HELLGATE cost cap — L1 structured cost decision (observability)", () => {
  const capture = (): { events: DecisionEvent[]; emit(e: DecisionEvent): void } => {
    const events: DecisionEvent[] = []
    return { events, emit: (e) => events.push(e) }
  }

  test("cost trip stamps pricingVersion into the decision metadata (reproducible)", () => {
    const emitter = capture()
    const ex: BudgetExhaustion = { exhausted: true, kind: "cost_usd", budget: 2, observed: 5.25 }
    emitBudgetExhaustedDecision(emitter, ex, { turn: 7 })
    expect(emitter.events).toHaveLength(1)
    const ev = emitter.events[0]
    expect(ev?.kind).toBe("budget")
    expect(ev?.metadata).toMatchObject({
      kind: "cost_usd",
      used: 5.25,
      limit: 2,
      pricingVersion: PRICING_VERSION,
    })
  })

  test("NON-cost trip metadata stays byte-identical (no pricingVersion leak)", () => {
    const emitter = capture()
    const ex: BudgetExhaustion = { exhausted: true, kind: "turn", budget: 60, observed: 61 }
    emitBudgetExhaustedDecision(emitter, ex, { turn: 61 })
    expect(emitter.events[0]?.metadata).toEqual({ kind: "turn", used: 61, limit: 60 })
    expect(emitter.events[0]?.metadata).not.toHaveProperty("pricingVersion")
  })

  test("non-exhausted ⇒ no decision emitted (allow-silence)", () => {
    const emitter = capture()
    emitBudgetExhaustedDecision(emitter, { exhausted: false }, { turn: 1 })
    expect(emitter.events).toHaveLength(0)
  })
})
