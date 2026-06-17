import { describe, expect, test } from "bun:test"
import {
  decideGate,
  decidePrimaryRailFinishGate,
  decideRepairAdmission,
  type GateSignals,
  type PrimaryRailResult,
} from "@/agent/primary-rail"

/**
 * T-302 keystone — primary-rail enforcement + gate decision + repair admission.
 *
 * Closes the false-green hole: today `runValidate` clears on the AGENT's own
 * `lastVerifyCmd` (any test-like bash) — sympy-23262 gamed exactly that. The
 * gate must instead clear ONLY on the planner-selected primaryRail, and a
 * NON-primary green must NOT clear it. Repair may iterate ONLY when an admissible
 * primaryRail exists and is RED. The commit-vs-verify gate is bidirectional and
 * categorical (no heuristic thresholds): trivial low-stakes/low-uncertainty
 * cases may commit early; everything else must verify the primary rail.
 *
 * All three deciders are PURE. cfg/state absent ⇒ OFF (byte-identical).
 */

describe("T-302 decideGate — commit-now vs verify (bidirectional, categorical)", () => {
  const base: GateSignals = {
    stakes: "high",
    uncertainty: "high",
    primaryRailAvailable: true,
    emptyPatchPressure: false,
  }

  test("GATE-1: low stakes AND low uncertainty ⇒ commit-now (early-commit allowed)", () => {
    const d = decideGate({ ...base, stakes: "low", uncertainty: "low" })
    expect(d.action).toBe("commit-now")
  })

  // red-on-injection: flip the rule to "commit on either low" and GATE-2/3 fail.
  test("GATE-2: high stakes (even with low uncertainty) ⇒ verify", () => {
    expect(decideGate({ ...base, stakes: "high", uncertainty: "low" }).action).toBe("verify")
  })

  test("GATE-3: high uncertainty (even with low stakes) ⇒ verify", () => {
    expect(decideGate({ ...base, stakes: "low", uncertainty: "high" }).action).toBe("verify")
  })

  test("GATE-4: empty-patch pressure never yields commit-now (nothing to commit)", () => {
    const d = decideGate({
      ...base,
      stakes: "low",
      uncertainty: "low",
      emptyPatchPressure: true,
    })
    expect(d.action).toBe("verify")
  })

  test("GATE-5: every decision carries a structured reason", () => {
    expect(decideGate({ ...base, stakes: "low", uncertainty: "low" }).reason.length).toBeGreaterThan(0)
    expect(decideGate(base).reason.length).toBeGreaterThan(0)
  })
})

describe("T-302 decideRepairAdmission — repair iterates ONLY on a red primary rail", () => {
  test("ADM-1: primaryRail present AND red ⇒ admit repair", () => {
    expect(decideRepairAdmission({ primaryRailPresent: true, primaryRailState: "red" }).admit).toBe(
      true,
    )
  })

  test("ADM-2: no primaryRail ⇒ deny (no blind repair without an admissible rail)", () => {
    expect(decideRepairAdmission({ primaryRailPresent: false, primaryRailState: "unrun" }).admit).toBe(
      false,
    )
  })

  test("ADM-3: primaryRail GREEN ⇒ deny (already proven; nothing to repair)", () => {
    expect(decideRepairAdmission({ primaryRailPresent: true, primaryRailState: "green" }).admit).toBe(
      false,
    )
  })

  test("ADM-4: primaryRail present but UNRUN ⇒ deny (not yet proven red)", () => {
    expect(
      decideRepairAdmission({ primaryRailPresent: true, primaryRailState: "unrun" }).admit,
    ).toBe(false)
  })
})

describe("T-302 decidePrimaryRailFinishGate — non-primary green must NOT clear the gate", () => {
  const cfg = { enabled: true } as const

  test("FIN-1: cfg absent ⇒ never block (OFF / byte-identical)", () => {
    const r: PrimaryRailResult = {
      primaryRailPresent: true,
      primaryRailState: "red",
      nonPrimaryGreens: 3,
    }
    expect(decidePrimaryRailFinishGate({ cfg: undefined, result: r }).block).toBe(false)
  })

  test("FIN-2: primary RED at finish ⇒ block (even with non-primary greens) — the false-green killer", () => {
    const r: PrimaryRailResult = {
      primaryRailPresent: true,
      primaryRailState: "red",
      nonPrimaryGreens: 5,
    }
    expect(decidePrimaryRailFinishGate({ cfg, result: r }).block).toBe(true)
  })

  test("FIN-3: primary UNRUN at finish ⇒ block (non-primary greens do not substitute)", () => {
    const r: PrimaryRailResult = {
      primaryRailPresent: true,
      primaryRailState: "unrun",
      nonPrimaryGreens: 2,
    }
    expect(decidePrimaryRailFinishGate({ cfg, result: r }).block).toBe(true)
  })

  test("FIN-4: primary GREEN ⇒ allow finish", () => {
    const r: PrimaryRailResult = {
      primaryRailPresent: true,
      primaryRailState: "green",
      nonPrimaryGreens: 0,
    }
    expect(decidePrimaryRailFinishGate({ cfg, result: r }).block).toBe(false)
  })

  test("FIN-5: NO primary rail ⇒ do not block on this gate (rail-absent is T-501/T-301's concern, not a false-green here)", () => {
    const r: PrimaryRailResult = {
      primaryRailPresent: false,
      primaryRailState: "unrun",
      nonPrimaryGreens: 4,
    }
    expect(decidePrimaryRailFinishGate({ cfg, result: r }).block).toBe(false)
  })
})
