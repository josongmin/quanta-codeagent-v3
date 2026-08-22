import { describe, expect, test } from "bun:test"
import type { PlanExitDecision } from "@/agent/plan-exit"
import {
  ALL_PLAN_EXIT_DECISIONS,
  buildPlanExit,
  PlanExitInvariantError,
  planExitAllowsMutation,
  planExitStaysInPlan,
} from "@/agent/plan-exit"

describe("buildPlanExit — three decisions", () => {
  test("approved builds without feedback", () => {
    const out = buildPlanExit({ decision: "approved" })
    expect(out).toEqual({ decision: "approved" })
    expect("feedback" in out).toBe(false)
  })

  test("rejected builds without feedback", () => {
    const out = buildPlanExit({ decision: "rejected" })
    expect(out).toEqual({ decision: "rejected" })
    expect("feedback" in out).toBe(false)
  })

  test("changes_requested builds with feedback", () => {
    const out = buildPlanExit({ decision: "changes_requested", feedback: "tighten step 2" })
    expect(out).toEqual({ decision: "changes_requested", feedback: "tighten step 2" })
  })

  test("ALL_PLAN_EXIT_DECISIONS enumerates exactly the three literals", () => {
    expect([...ALL_PLAN_EXIT_DECISIONS].sort()).toEqual([
      "approved",
      "changes_requested",
      "rejected",
    ])
  })
})

describe("buildPlanExit — feedback-required-iff-changes invariant", () => {
  test("changes_requested without feedback throws", () => {
    expect(() => buildPlanExit({ decision: "changes_requested" })).toThrow(PlanExitInvariantError)
  })

  test("changes_requested with whitespace-only feedback throws", () => {
    expect(() => buildPlanExit({ decision: "changes_requested", feedback: "   " })).toThrow(
      PlanExitInvariantError,
    )
  })

  test("approved with feedback throws", () => {
    expect(() => buildPlanExit({ decision: "approved", feedback: "extra" })).toThrow(
      PlanExitInvariantError,
    )
  })

  test("rejected with feedback throws", () => {
    expect(() => buildPlanExit({ decision: "rejected", feedback: "extra" })).toThrow(
      PlanExitInvariantError,
    )
  })

  test("thrown error carries the decision and a stable code", () => {
    try {
      buildPlanExit({ decision: "changes_requested" })
      throw new Error("expected throw")
    } catch (e) {
      expect(e).toBeInstanceOf(PlanExitInvariantError)
      const err = e as PlanExitInvariantError
      expect(err.decision).toBe("changes_requested")
      expect(err.code).toBe("plan_exit_invariant")
    }
  })
})

describe("plan-exit predicates", () => {
  test("planExitAllowsMutation: only approved", () => {
    const map: Record<PlanExitDecision, boolean> = {
      approved: true,
      rejected: false,
      changes_requested: false,
    }
    for (const d of ALL_PLAN_EXIT_DECISIONS) {
      expect(planExitAllowsMutation(d)).toBe(map[d])
    }
  })

  test("planExitStaysInPlan: only changes_requested", () => {
    const map: Record<PlanExitDecision, boolean> = {
      approved: false,
      rejected: false,
      changes_requested: true,
    }
    for (const d of ALL_PLAN_EXIT_DECISIONS) {
      expect(planExitStaysInPlan(d)).toBe(map[d])
    }
  })
})
