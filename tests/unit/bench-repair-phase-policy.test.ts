import { describe, expect, test } from "bun:test"
import type { PrimaryRailStep } from "@/agent/closure"
import type { VerificationPlan } from "@/agent/verification-plan"
import {
  benchShouldRunRepairPhase,
  primaryRailRedAfterRepair,
} from "@/runner/batch/eval/repair-phase-policy"

const railStep: PrimaryRailStep = {
  kind: "owner-test",
  cmd: "python reproduce_issue.py",
  authority: "execution",
  successPredicate: { type: "selected_test_passes" },
}

const redPlan: VerificationPlan = {
  primaryRail: { kind: "repro", cmd: "python reproduce_issue.py" },
  required: [],
  optional: [],
  baseValidatedRed: true,
  primaryRailBaseValidatedRed: true,
}

describe("bench repair-phase policy", () => {
  test("primaryRail OFF keeps the legacy repair loop even when the gate says commit-now", () => {
    expect(
      benchShouldRunRepairPhase({
        eligible: true,
        primaryRailEnabled: false,
        gateAction: "commit-now",
        primaryRailStep: undefined,
        verificationPlan: undefined,
      }),
    ).toBe(true)
  })

  test("primaryRail ON + no admissible rail => no repair loop", () => {
    expect(
      benchShouldRunRepairPhase({
        eligible: true,
        primaryRailEnabled: true,
        gateAction: "verify",
        primaryRailStep: undefined,
        verificationPlan: undefined,
      }),
    ).toBe(false)
  })

  test("primaryRail ON + red rail + verify gate => repair loop runs", () => {
    expect(
      benchShouldRunRepairPhase({
        eligible: true,
        primaryRailEnabled: true,
        gateAction: "verify",
        primaryRailStep: railStep,
        verificationPlan: redPlan,
      }),
    ).toBe(true)
  })

  test("owner-test primary rail with observed base-red proof also admits repair", () => {
    expect(
      benchShouldRunRepairPhase({
        eligible: true,
        primaryRailEnabled: true,
        gateAction: "verify",
        primaryRailStep: railStep,
        verificationPlan: {
          primaryRail: { kind: "owner-test", cmd: "python -m pytest tests/test_owner.py" },
          required: [],
          optional: [],
          baseValidatedRed: false,
          primaryRailBaseValidatedRed: true,
        },
      }),
    ).toBe(true)
  })

  test("primaryRail ON + red rail + commit-now gate => repair loop stays off", () => {
    expect(
      benchShouldRunRepairPhase({
        eligible: true,
        primaryRailEnabled: true,
        gateAction: "commit-now",
        primaryRailStep: railStep,
        verificationPlan: redPlan,
      }),
    ).toBe(false)
  })

  test("predicate false-green keeps the primary rail red for escalation", () => {
    expect(primaryRailRedAfterRepair(railStep, true, true)).toBe(true)
    expect(primaryRailRedAfterRepair(railStep, false, false)).toBe(true)
    expect(primaryRailRedAfterRepair(railStep, true, false)).toBe(false)
  })
})
