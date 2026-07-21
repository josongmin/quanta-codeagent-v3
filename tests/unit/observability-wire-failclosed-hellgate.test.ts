/**
 * DOF-40 — observability partial-wire fail-closed hellgate.
 *
 * Boundary under test: `wireObservability`. Historically a port factory or a
 * hookBus.subscribe() throw degraded the corresponding slot to `undefined`
 * with NO signal to the operator — an absent slot was AMBIGUOUS between
 * "host opted out" and "the factory threw". A partial-wire failure was thus
 * SILENTLY OFFLINE.
 *
 * These cases pin:
 *   1. ISOLATION — one throwing factory leaves the other three slots intact.
 *   2. SURFACING — the failed slot is named in `handle.degraded` AND routed
 *      to the optional `onPortError` observer. Which port is offline is
 *      VISIBLE, not inferred from absence.
 *   3. OPT-OUT ≠ FAILURE — a host that simply does not pass a hookBus (or
 *      repoRoot) produces NO degraded entry (voluntary absence is not a
 *      breakage).
 *   4. OFF byte-identical — gate unset ⇒ NOOP handle with an EMPTY degraded
 *      report + NO port factory invoked + NO observer fired.
 *
 * We cannot make the REAL leaf factories throw from the outside, so the
 * factory-throw path is exercised via the ONE externally-controllable
 * throwing seam the wire has: a hostile `hookBus.subscribe` (the
 * "attribution" slot). Isolation of the OTHER slots (they stay populated) is
 * proven alongside. The construct-time report plumbing (`degraded` array +
 * `onPortError`) is the same code path for every slot.
 */

import { describe, expect, test } from "bun:test"
import {
  OBSERVABILITY_WIRE_SLOTS,
  type ObservabilityHookBus,
  type ObservabilityWirePortError,
  wireObservability,
} from "@/agent/observability-wire"

/* ------------------------------------------------------------------ */
/* Rig                                                                 */
/* ------------------------------------------------------------------ */

const throwingBus: ObservabilityHookBus = {
  subscribe: () => {
    throw new Error("hook-bus-rejected-registration")
  },
}

const okBus = (calls: { count: number }): ObservabilityHookBus => ({
  subscribe: () => {
    calls.count += 1
    return () => undefined
  },
})

/* ================================================================== */
/* A. OFF byte-identical                                               */
/* ================================================================== */

describe("A. gate OFF (default)", () => {
  test("A1 no enabled ⇒ empty degraded, no observer fires, no factory touched", () => {
    let observed = 0
    const h = wireObservability({ onPortError: () => (observed += 1) })
    expect(h.degraded).toEqual([])
    expect(observed).toBe(0)
    // NOOP handle: no ports.
    expect(h.objective).toBeUndefined()
    expect(h.runLedger).toBeUndefined()
  })

  test("A2 hostile bus while gate OFF is NEVER invoked (no subscribe attempted)", () => {
    let observed = 0
    const h = wireObservability({
      hookBus: throwingBus, // would throw IF called — it must not be
      onPortError: () => (observed += 1),
    })
    expect(h.degraded).toEqual([])
    expect(observed).toBe(0)
  })
})

/* ================================================================== */
/* B. attribution-slot failure surfaced                                */
/* ================================================================== */

describe("B. attribution subscribe throw is SURFACED", () => {
  test("B1 degraded names the attribution slot + observer fires; sibling ports intact", () => {
    const seen: ObservabilityWirePortError[] = []
    const h = wireObservability({
      enabled: true,
      hookBus: throwingBus,
      onPortError: (e) => seen.push(e),
    })
    // ISOLATION — the three wave-1/2 ports still constructed.
    expect(h.objective).toBeDefined()
    expect(h.runLedger).toBeDefined()
    expect(h.approvalStateMachine).toBeDefined()
    // SURFACING — exactly one degraded entry, naming "attribution".
    expect(h.degraded).toHaveLength(1)
    expect(h.degraded[0]?.slot).toBe("attribution")
    expect(h.degraded[0]?.message).toContain("hook-bus-rejected-registration")
    // Observer received the SAME failure.
    expect(seen).toHaveLength(1)
    expect(seen[0]?.slot).toBe("attribution")
    // detach still callable + NO-THROW.
    expect(() => h.detach()).not.toThrow()
  })

  test("B2 clean wire ⇒ empty degraded (attribution actually subscribed)", () => {
    const calls = { count: 0 }
    const h = wireObservability({ enabled: true, hookBus: okBus(calls) })
    expect(calls.count).toBe(1)
    expect(h.degraded).toEqual([])
  })
})

/* ================================================================== */
/* C. opt-out is NOT a failure                                         */
/* ================================================================== */

describe("C. voluntary absence ≠ degraded", () => {
  test("C1 no hookBus ⇒ ports wired, degraded empty (attribution opted out, not broken)", () => {
    const h = wireObservability({ enabled: true })
    expect(h.objective).toBeDefined()
    expect(h.runLedger).toBeDefined()
    // Attribution was never requested ⇒ NOT a degradation.
    expect(h.degraded).toEqual([])
  })

  test("C2 no repoRoot ⇒ shadowVerify absent but NOT degraded", () => {
    const h = wireObservability({ enabled: true })
    expect(h.shadowVerify).toBeUndefined()
    expect(h.degraded.map((d) => d.slot)).not.toContain("shadowVerify")
  })
})

/* ================================================================== */
/* D. observer robustness + slot enumeration                           */
/* ================================================================== */

describe("D. robustness", () => {
  test("D1 a THROWING onPortError never breaks wiring; degraded still recorded", () => {
    let h: ReturnType<typeof wireObservability> | undefined
    expect(() => {
      h = wireObservability({
        enabled: true,
        hookBus: throwingBus,
        onPortError: () => {
          throw new Error("observer-also-throws")
        },
      })
    }).not.toThrow()
    expect(h?.degraded).toHaveLength(1)
    expect(h?.degraded[0]?.slot).toBe("attribution")
  })

  test("D2 slot enumeration covers every declared slot (drift guard)", () => {
    // Every slot the wire can degrade must be in the closed enumeration.
    const expected: (typeof OBSERVABILITY_WIRE_SLOTS)[number][] = [
      "approvalStateMachine",
      "attribution",
      "objective",
      "runLedger",
      "shadowVerify",
    ]
    expect([...OBSERVABILITY_WIRE_SLOTS].sort()).toEqual(expected.sort())
  })

  test("D3 degraded array is frozen (caller cannot mutate the failure record)", () => {
    const h = wireObservability({ enabled: true, hookBus: throwingBus })
    expect(Object.isFrozen(h.degraded)).toBe(true)
  })
})
