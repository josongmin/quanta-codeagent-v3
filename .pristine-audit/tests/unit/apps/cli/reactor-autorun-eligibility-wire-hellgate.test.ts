/**
 * ADR-0453 jun-02 wire hellgate — the reactor's 4th-guard autorun-eligibility
 * resolver is LIVE at the REPL composition root (`buildAutorunEligibility`),
 * not merely a pure evaluator + an unwired optional port.
 *
 * Round-2 audit found ADR-0453 claimed `deliberate_hold: null` + L3 "fully
 * integrated" but NO composition root ever injected an `eligibility` resolver
 * into the reactor self-wake — so the 4th guard was always absent (a dead seam,
 * the fc claim was false). This proves the wire that closes the seam:
 *
 *   HELL-AE-01  knob UNSET ⇒ resolver `undefined` (default-OFF: the reactor
 *               keeps its pre-ADR-0453 3-guard path byte-identical).
 *   HELL-AE-02  UNRECOGNIZED value ⇒ `undefined` (fail toward off, no throw).
 *   HELL-AE-03  `never` ⇒ resolver yields a NOT-eligible verdict (`policy-never`).
 *   HELL-AE-04  `always` ⇒ ELIGIBLE (`policy-always`).
 *   HELL-AE-05  `on-failure` reads the prior outcome at CALL time (fresh per
 *               wake): fail ⇒ eligible, success ⇒ blocked — proving the getter,
 *               not a captured snapshot, drives the verdict.
 *   HELL-AE-06  `on-request` with no standing approval ⇒ blocked (the additive
 *               gate can only BLOCK, never force).
 */
import { describe, expect, it } from "bun:test"
import { buildAutorunEligibility } from "@/permission"
import type { LastTurnOutcome } from "@/reactor"

const never = () => undefined as LastTurnOutcome | undefined

describe("ADR-0453 wire — QUANTA_AUTORUN_POLICY at the reactor composition root", () => {
  it("HELL-AE-01: knob unset ⇒ resolver undefined (default-OFF 3-guard path)", () => {
    expect(buildAutorunEligibility({}, never)).toBeUndefined()
  })

  it("HELL-AE-02: unrecognized value ⇒ undefined (fail toward off, no throw)", () => {
    expect(buildAutorunEligibility({ QUANTA_AUTORUN_POLICY: "sometimes" }, never)).toBeUndefined()
  })

  it("HELL-AE-03: never ⇒ NOT eligible (policy-never)", () => {
    const r = buildAutorunEligibility({ QUANTA_AUTORUN_POLICY: "never" }, never)
    expect(r).toBeDefined()
    expect(r?.()).toEqual({ eligible: false, reason: "policy-never" })
  })

  it("HELL-AE-04: always ⇒ eligible (policy-always)", () => {
    const r = buildAutorunEligibility({ QUANTA_AUTORUN_POLICY: "always" }, never)
    expect(r?.()).toEqual({ eligible: true, reason: "policy-always" })
  })

  it("HELL-AE-05: on-failure reads prior outcome at CALL time (fresh per wake)", () => {
    let outcome: LastTurnOutcome | undefined
    const r = buildAutorunEligibility({ QUANTA_AUTORUN_POLICY: "on-failure" }, () => outcome)
    expect(r).toBeDefined()
    // First wake: prior turn failed ⇒ eligible.
    outcome = "fail"
    expect(r?.()).toEqual({ eligible: true, reason: "on-failure-failed" })
    // Next wake after a success ⇒ blocked. Proves the getter is re-read, not
    // a captured snapshot.
    outcome = "success"
    expect(r?.()).toEqual({ eligible: false, reason: "on-failure-not-failed" })
    // Absent outcome ⇒ treated as non-failure (fail toward NOT auto-running).
    outcome = undefined
    expect(r?.()).toEqual({ eligible: false, reason: "on-failure-not-failed" })
  })

  it("HELL-AE-06: on-request with no standing approval ⇒ blocked", () => {
    const r = buildAutorunEligibility({ QUANTA_AUTORUN_POLICY: "on-request" }, never)
    expect(r?.()).toEqual({ eligible: false, reason: "on-request-absent" })
  })
})
