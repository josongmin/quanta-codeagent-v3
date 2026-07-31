/**
 * WS1 hellgate — canonical delivery contract (RFC jul-18 §3, §4.1).
 *
 * These rails pin the SSOT vocabulary + closed taxonomies as RUNTIME behavior,
 * not just compile-time drift guards (which a `bun test` typecheck gap could let
 * rot — see the project's compile-assert caveat). Every assertion observes a
 * real effect: an unknown mode is NOT normalized to queue; the steer→delivery
 * bridge is total and correct; the closed reason arrays match their unions.
 */

import { describe, expect, it } from "bun:test"
import { ALL_REJECTION_REASONS, type SteerRejectionReason } from "@/agent/steer-reasons"
import {
  ALL_DELIVERY_DEGRADE_REASONS,
  ALL_DELIVERY_REJECT_REASONS,
  type DeliveryDegradeReason,
  steerRejectionToDelivery,
} from "@/agent/subagent-delivery/types"
import {
  ALL_ACTIVATION_POLICIES,
  ALL_DELIVERY_MODES,
  isDeliveryMode,
  parseActivationPolicy,
  parseDeliveryMode,
} from "@/shared"

describe("WS1 delivery contract — mode parsing", () => {
  it("accepts exactly the three canonical modes", () => {
    expect([...ALL_DELIVERY_MODES]).toEqual(["queue", "steer", "interrupt"])
    for (const m of ALL_DELIVERY_MODES) expect(parseDeliveryMode(m)).toBe(m)
  })

  it("rejects an unknown mode as undefined — NEVER normalizes to queue (RFC §3.2)", () => {
    expect(parseDeliveryMode("weave")).toBeUndefined()
    expect(parseDeliveryMode("QUEUE")).toBeUndefined()
    expect(parseDeliveryMode("")).toBeUndefined()
    expect(parseDeliveryMode(undefined)).toBeUndefined()
    expect(parseDeliveryMode(0)).toBeUndefined()
    expect(isDeliveryMode("weave")).toBe(false)
  })

  it("activation policy parses strictly", () => {
    expect([...ALL_ACTIVATION_POLICIES]).toEqual(["passive", "ensure-turn"])
    expect(parseActivationPolicy("ensure-turn")).toBe("ensure-turn")
    expect(parseActivationPolicy("wake")).toBeUndefined()
  })
})

describe("WS1 delivery contract — steer→delivery bridge (SSOT, RFC §7)", () => {
  it("is total over every SteerRejectionReason with no gaps", () => {
    for (const r of ALL_REJECTION_REASONS) {
      const mapped = steerRejectionToDelivery(r)
      expect(mapped).toBeDefined()
    }
  })

  it("maps the five steerability reasons to identical delivery literals", () => {
    const shared: SteerRejectionReason[] = [
      "no_active_turn",
      "expected_turn_mismatch",
      "non_steerable_review",
      "non_steerable_compact",
      "non_steerable_standalone",
    ]
    for (const r of shared) expect(steerRejectionToDelivery(r)).toBe(r as DeliveryDegradeReason)
  })

  it("maps 'interrupted' to 'already_interrupted' and pre-validated input reasons to the invalid_input sentinel", () => {
    expect(steerRejectionToDelivery("interrupted")).toBe("already_interrupted")
    expect(steerRejectionToDelivery("empty_input")).toBe("invalid_input")
    expect(steerRejectionToDelivery("input_too_large")).toBe("invalid_input")
  })
})

describe("WS1 delivery contract — closed reason taxonomies", () => {
  it("degrade + reject reason arrays are duplicate-free and non-empty", () => {
    expect(new Set(ALL_DELIVERY_DEGRADE_REASONS).size).toBe(ALL_DELIVERY_DEGRADE_REASONS.length)
    expect(new Set(ALL_DELIVERY_REJECT_REASONS).size).toBe(ALL_DELIVERY_REJECT_REASONS.length)
    expect(ALL_DELIVERY_DEGRADE_REASONS.length).toBeGreaterThan(0)
    expect(ALL_DELIVERY_REJECT_REASONS.length).toBeGreaterThan(0)
  })

  it("the steer-overlap degrade reasons are a subset of steer rejection reasons (SSOT link)", () => {
    const steerSet = new Set<string>(ALL_REJECTION_REASONS)
    const overlap = ALL_DELIVERY_DEGRADE_REASONS.filter((r) => steerSet.has(r))
    expect(overlap).toEqual([
      "no_active_turn",
      "expected_turn_mismatch",
      "non_steerable_review",
      "non_steerable_compact",
      "non_steerable_standalone",
    ])
  })
})
