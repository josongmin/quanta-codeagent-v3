/**
 * GOAL-05A (domain half) — same-ID budget amendment rules live in the AUTHORITY
 * so the CLI and the web share them:
 *   - a completed objective rejects amendment (`terminal-objective`) for every actor;
 *   - caps are clamped to the PRODUCT ceiling on create / replace / amend;
 *   - amendment preserves the objective id and every evidence receipt;
 *   - an exhausted USER turn limit re-derives `active` once the amendment leaves
 *     positive user budget (the product hard cap is GOAL-06's and is never reset).
 */

import { describe, expect, test } from "bun:test"
import {
  clampBudgetLimit,
  createObjectiveAuthority,
  createObjectiveCapabilities,
  PRODUCT_BUDGET_CEILING,
} from "@/objective"
import { settleTurns } from "./v2-helpers"

describe("GOAL-05A — budget amendment (authority-owned)", () => {
  test("clampBudgetLimit bounds both caps to the product ceiling and drops garbage", () => {
    expect(clampBudgetLimit({ maxTurns: PRODUCT_BUDGET_CEILING.maxTurns + 1 })).toEqual({
      maxTurns: PRODUCT_BUDGET_CEILING.maxTurns,
    })
    expect(
      clampBudgetLimit({ maxTokens: PRODUCT_BUDGET_CEILING.maxTokens * 2, maxTurns: 3 }),
    ).toEqual({
      maxTokens: PRODUCT_BUDGET_CEILING.maxTokens,
      maxTurns: 3,
    })
    expect(clampBudgetLimit({ maxTurns: -1, maxTokens: Number.NaN })).toEqual({})
    expect(clampBudgetLimit({})).toEqual({})
  })

  test("create / replace / amend clamp to the product ceiling (same rule on every path)", () => {
    const authority = createObjectiveAuthority({ now: () => 1 })
    authority.create("t", {
      goal: "g",
      successCriteria: ["c"],
      budget: { maxTurns: PRODUCT_BUDGET_CEILING.maxTurns + 5 },
    })
    expect(authority.get("t")?.budget.maxTurns).toBe(PRODUCT_BUDGET_CEILING.maxTurns)
    authority.replace("t", {
      goal: "g2",
      budget: { maxTokens: PRODUCT_BUDGET_CEILING.maxTokens + 9 },
    })
    expect(authority.get("t")?.budget.maxTokens).toBe(PRODUCT_BUDGET_CEILING.maxTokens)
    const caps = createObjectiveCapabilities(authority)
    expect(
      caps.user.commit("t", {
        kind: "amendBudget",
        budget: { maxTurns: PRODUCT_BUDGET_CEILING.maxTurns * 3 },
      }).ok,
    ).toBe(true)
    expect(authority.get("t")?.budget.maxTurns).toBe(PRODUCT_BUDGET_CEILING.maxTurns)
  })

  test("amendment preserves the objective id and the evidence; a completed objective rejects it", () => {
    const authority = createObjectiveAuthority({ now: () => 1 })
    authority.create("t", { goal: "g", successCriteria: ["c"] })
    const caps = createObjectiveCapabilities(authority)
    const id = authority.get("t")?.objectiveId
    const criterionId = authority.get("t")?.successCriteria[0]?.id ?? ""
    expect(caps.user.commit("t", { kind: "amendBudget", budget: { maxTurns: 4 } }).ok).toBe(true)
    expect(authority.get("t")?.objectiveId).toBe(id)
    // Complete it through a trusted manual attestation ⇒ derived `completed`.
    expect(caps.user.commit("t", { kind: "markCriterion", criterionId, met: true }).ok).toBe(true)
    expect(authority.get("t")?.status).toBe("completed")
    for (const actor of ["user", "system"] as const) {
      const res = authority.commit(
        authority.prepare({
          threadId: "t",
          actor,
          mutation: { kind: "amendBudget", budget: { maxTurns: 9 } },
        }),
        { admitted: true },
      )
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.reason).toBe("terminal-objective")
    }
    expect(authority.get("t")?.budget.maxTurns).toBe(4)
    expect(authority.get("t")?.objectiveId).toBe(id)
    expect(authority.get("t")?.successCriteria[0]?.completion?.source).toBe("manual")
  })

  test("an exhausted USER turn limit reactivates when the amendment leaves positive budget", () => {
    const authority = createObjectiveAuthority({ now: () => 1, enforceBudget: true })
    authority.create("t", { goal: "g", successCriteria: ["c"], budget: { maxTurns: 1 } })
    settleTurns(authority, "t", 1)
    expect(authority.get("t")?.status).toBe("budget_limited")
    const caps = createObjectiveCapabilities(authority)
    expect(caps.user.commit("t", { kind: "amendBudget", budget: { maxTurns: 3 } }).ok).toBe(true)
    expect(authority.get("t")?.status).toBe("active")
    expect(authority.get("t")?.budget.turnsUsed).toBe(1)
  })
})
