/**
 * HELLGATE — adversarial dial-clamp invariants (ADR-RFC §8.3, §6 decision).
 *
 * The clamp must NEVER let a poison value (NaN / ±Infinity / negative)
 * through the gate. Companion to `tests/unit/agent/run-mode/clamp.test.ts`
 * (which covers the happy path of cap-binding semantics). This file covers
 * EDGE cases — every IEEE-754 corner the propositional resolveDial() must
 * defend against, plus the onClamp event-emit contract.
 *
 * 17 cases / 47+ expects.
 */

import { describe, expect, test } from "bun:test"
import type { BudgetClampEvent } from "@/agent/budget/events"
import type { BudgetCaps, BudgetDials } from "@/agent/budget/types"
import { __TEST_DIAL_FIELDS as DIAL_FIELDS, clampDials } from "@/agent/run-mode/clamp"

const NEAR_INT_MAX = Number.MAX_SAFE_INTEGER

describe("HELL-CLAMP — propositional clamp adversarial cases", () => {
  test("CASE 01 — NaN requested treated as absent (dial dropped)", () => {
    const out = clampDials({ maxTurns: Number.NaN } as BudgetDials, { maxTurns: 10 })
    // requested=NaN drops to absent → resolveDial returns the cap as fallback
    expect(out.maxTurns).toBe(10)
  })

  test("CASE 02 — +Infinity requested treated as absent", () => {
    const out = clampDials(
      { maxTurns: Number.POSITIVE_INFINITY } as BudgetDials,
      { maxTurns: 10 },
    )
    expect(out.maxTurns).toBe(10)
  })

  test("CASE 03 — -Infinity requested treated as absent", () => {
    const out = clampDials(
      { maxTurns: Number.NEGATIVE_INFINITY } as BudgetDials,
      { maxTurns: 10 },
    )
    expect(out.maxTurns).toBe(10)
  })

  test("CASE 04 — negative requested treated as absent (defensive)", () => {
    const out = clampDials({ maxTurns: -5 } as BudgetDials, { maxTurns: 10 })
    expect(out.maxTurns).toBe(10)
  })

  test("CASE 05 — NaN cap treated as absent (requested wins, no clamp)", () => {
    let clamped = false
    const out = clampDials(
      { maxTurns: 5 },
      { maxTurns: Number.NaN } as BudgetCaps,
      () => {
        clamped = true
      },
    )
    expect(out.maxTurns).toBe(5)
    expect(clamped).toBe(false)
  })

  test("CASE 06 — both NaN ⇒ undefined (key omitted from output)", () => {
    const out = clampDials(
      { maxTurns: Number.NaN } as BudgetDials,
      { maxTurns: Number.NaN } as BudgetCaps,
    )
    expect(out.maxTurns).toBeUndefined()
    expect(Object.hasOwn(out, "maxTurns")).toBe(false)
  })

  test("CASE 07 — zero is a valid dial (not absent)", () => {
    const out = clampDials({ maxTurns: 0 }, { maxTurns: 10 })
    expect(out.maxTurns).toBe(0)
  })

  test("CASE 08 — negative-zero accepted (IEEE allows; >= 0)", () => {
    const out = clampDials({ maxTurns: -0 }, { maxTurns: 10 })
    expect(out.maxTurns).toBe(-0)
  })

  test("CASE 09 — Number.MAX_SAFE_INTEGER preserved when no cap", () => {
    const out = clampDials({ maxTurns: NEAR_INT_MAX }, {})
    expect(out.maxTurns).toBe(NEAR_INT_MAX)
  })

  test("CASE 10 — requested === cap is NOT clamped (strict > only)", () => {
    let clampedCount = 0
    const out = clampDials({ maxTurns: 10 }, { maxTurns: 10 }, () => {
      clampedCount++
    })
    expect(out.maxTurns).toBe(10)
    expect(clampedCount).toBe(0)
  })

  test("CASE 11 — requested > cap clamps to cap and emits ONE event", () => {
    const events: BudgetClampEvent[] = []
    const out = clampDials({ maxTurns: 100 }, { maxTurns: 10 }, (e) => {
      events.push(e)
    })
    expect(out.maxTurns).toBe(10)
    expect(events).toHaveLength(1)
    expect(events[0]?.dial).toBe("maxTurns")
    expect(events[0]?.requested).toBe(100)
    expect(events[0]?.cap).toBe(10)
  })

  test("CASE 12 — multiple field clamps emit one event per field", () => {
    const events: BudgetClampEvent[] = []
    clampDials(
      { maxTurns: 100, maxToolCalls: 50, maxCostUsd: 9 } as BudgetDials,
      { maxTurns: 10, maxToolCalls: 20, maxCostUsd: 5 } as BudgetCaps,
      (e) => {
        events.push(e)
      },
    )
    expect(events).toHaveLength(3)
    expect(events.map((e) => e.dial).sort()).toEqual(["maxCostUsd", "maxToolCalls", "maxTurns"])
  })

  test("CASE 13 — onClamp NOT called when no field clamps (cold path)", () => {
    let called = false
    clampDials({ maxTurns: 5 }, { maxTurns: 10 }, () => {
      called = true
    })
    expect(called).toBe(false)
  })

  test("CASE 14 — DIAL_FIELDS is a closed enum (every entry is a known dial)", () => {
    expect(DIAL_FIELDS.length).toBeGreaterThanOrEqual(10)
    for (const f of DIAL_FIELDS) {
      expect(typeof f).toBe("string")
      expect(f).toMatch(/^(max|compaction)/)
    }
  })

  test("CASE 15 — input objects are NEVER mutated (pure function)", () => {
    const dials: BudgetDials = { maxTurns: 100 }
    const caps: BudgetCaps = { maxTurns: 10 }
    const dialsFrozen = JSON.stringify(dials)
    const capsFrozen = JSON.stringify(caps)
    clampDials(dials, caps)
    expect(JSON.stringify(dials)).toBe(dialsFrozen)
    expect(JSON.stringify(caps)).toBe(capsFrozen)
  })

  test("CASE 16 — returned object is a fresh allocation (not the input ref)", () => {
    const dials: BudgetDials = { maxTurns: 5 }
    const out = clampDials(dials, { maxTurns: 10 })
    expect(out).not.toBe(dials)
  })

  test("CASE 17 — unknown fields in input are SILENTLY DROPPED (closed enum guard)", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberate type-cheat to verify the closed enum drops unknown fields
    const out = clampDials({ maxTurns: 5, bogusField: 999 } as any, { maxTurns: 10 })
    expect(out.maxTurns).toBe(5)
    expect(Object.hasOwn(out, "bogusField")).toBe(false)
  })
})
