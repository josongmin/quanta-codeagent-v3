/**
 * HELLGATE — L3 per-turn cost ceiling (runaway-turn guard).
 *
 * maxCostUsd caps CUMULATIVE spend; a single runaway turn can still burn a huge
 * amount in one shot while the cumulative total is low. maxCostPerTurnUsd trips
 * on ONE turn's cost, reset at each `tick("turn")` boundary. Propositional dial,
 * NOT a velocity heuristic; absent dial ⇒ byte-identical.
 */
import { describe, expect, test } from "bun:test"
import { BudgetMeter } from "@/agent"

describe("HELLGATE L3 — maxCostPerTurnUsd", () => {
  test("no dial ⇒ never trips on per-turn cost (byte-identical)", () => {
    const m = new BudgetMeter()
    m.tick("turn")
    m.tick("cost_usd", 1000)
    expect(m.checkExhausted().exhausted).toBe(false)
  })

  test("a single turn over the per-turn cap trips (even with low cumulative)", () => {
    const m = new BudgetMeter({ dials: { maxCostPerTurnUsd: 2, maxCostUsd: 1000 } })
    m.tick("turn")
    m.tick("cost_usd", 2.5) // this turn = $2.5 > $2 per-turn cap; cumulative $2.5 << $1000
    const ex = m.checkExhausted()
    expect(ex.exhausted).toBe(true)
    expect(ex.kind).toBe("cost_per_turn")
    expect(ex.budget).toBe(2)
    expect(ex.observed).toBeCloseTo(2.5, 6)
  })

  test("RESETS each turn — spend under the cap per turn never trips, even if cumulative is huge", () => {
    const m = new BudgetMeter({ dials: { maxCostPerTurnUsd: 2 } })
    for (let i = 0; i < 10; i++) {
      m.tick("turn")
      m.tick("cost_usd", 1.5) // $1.5/turn < $2 cap; cumulative reaches $15
      expect(m.checkExhausted().exhausted).toBe(false)
    }
    // The cumulative dial is absent ⇒ only per-turn governs ⇒ never trips.
    expect(m.snapshot().costUsd).toBeCloseTo(15, 6)
  })

  test("accumulates WITHIN a turn (multiple cost ticks before the next turn)", () => {
    const m = new BudgetMeter({ dials: { maxCostPerTurnUsd: 2 } })
    m.tick("turn")
    m.tick("cost_usd", 1.2)
    expect(m.checkExhausted().exhausted).toBe(false) // 1.2 < 2
    m.tick("cost_usd", 1.0) // same turn ⇒ 2.2 > 2
    expect(m.checkExhausted().kind).toBe("cost_per_turn")
  })

  test("cumulative cost_usd fires BEFORE per-turn (deterministic order)", () => {
    // Both would trip; the cumulative check comes first in checkExhausted.
    const m = new BudgetMeter({ dials: { maxCostUsd: 1, maxCostPerTurnUsd: 1 } })
    m.tick("turn")
    m.tick("cost_usd", 5)
    expect(m.checkExhausted().kind).toBe("cost_usd")
  })

  test("strict greater-than: per-turn cost === cap is NOT exhausted", () => {
    const m = new BudgetMeter({ dials: { maxCostPerTurnUsd: 2 } })
    m.tick("turn")
    m.tick("cost_usd", 2)
    expect(m.checkExhausted().exhausted).toBe(false)
  })
})
