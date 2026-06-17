/**
 * T-501 — no-patch breaker. Teeth: force-commit at the fraction, exhausted
 * verdict at budget end, no-op once an edit exists, #9296 path distinct.
 */
import { describe, expect, test } from "bun:test"
import { decideNoPatch } from "@/agent/no-patch-breaker"

describe("decideNoPatch", () => {
  test("any mutating edit → continue (rail inert)", () => {
    expect(decideNoPatch({ turnsUsed: 59, maxTurns: 60, hasMutatingEdit: true })).toEqual({ action: "continue" })
  })

  test("no edit at budget end → exhausted (the #9296 verdict)", () => {
    const d = decideNoPatch({ turnsUsed: 60, maxTurns: 60, hasMutatingEdit: false })
    expect(d.action).toBe("exhausted")
  })

  test("no edit past force-commit fraction → commit-now before exhaustion", () => {
    const d = decideNoPatch({ turnsUsed: 48, maxTurns: 60, hasMutatingEdit: false }) // 0.8*60=48
    expect(d.action).toBe("commit-now")
  })

  test("early with no edit → continue (don't fire prematurely)", () => {
    expect(decideNoPatch({ turnsUsed: 10, maxTurns: 60, hasMutatingEdit: false })).toEqual({ action: "continue" })
  })

  test("custom fraction respected", () => {
    expect(decideNoPatch({ turnsUsed: 5, maxTurns: 10, hasMutatingEdit: false, forceCommitAtFraction: 0.5 }).action).toBe("commit-now")
  })
})
