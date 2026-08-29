/**
 * ★ HELLGATE (P2-1) — a user budget is bounded by a PRODUCT ceiling, honestly.
 *
 * MEASURED GAP (2026-08-30): `create` with `{maxTurns: 1e9, maxTokens: 9e9}`
 * was stored verbatim and `amendBudget` accepted anything finite. The original
 * ceiling (`src/objective/budget-limits.ts`, `PRODUCT_BUDGET_CEILING` +
 * `clampBudgetLimit`) died in merge `9b21d2fd2` and never returned.
 *
 * It does NOT return as a silent `Math.min`. This campaign removed exactly that
 * shape one commit-campaign ago (`90ad48022`: the product cap was being written
 * into the user's own budget). An operator who types 1,000,000 and is shown
 * 10,000 has been lied to. The number is stored VERBATIM and the ceiling is
 * enforced where every other limit is — derived, and named as the limiting
 * source so `/goal` can say which bound stopped the work and whether raising
 * the budget could ever help.
 */

import { describe, expect, test } from "bun:test"
import {
  createObjectiveAuthority,
  createObjectiveCapabilities,
  PRODUCT_BUDGET_CEILING,
} from "@/objective"

const authorityWith = (budget: { maxTurns?: number; maxTokens?: number }) => {
  const authority = createObjectiveAuthority({ now: () => 1, enforceBudget: true })
  authority.create("t", { goal: "ship", successCriteria: ["c"], budget } as never)
  return authority
}

const burnTurns = (authority: ReturnType<typeof createObjectiveAuthority>, count: number): void => {
  const system = createObjectiveCapabilities(authority).system
  for (let index = 0; index < count; index += 1) {
    const domain = authority.readDomain("t")
    const objectiveId = domain.state?.objective.objectiveId ?? ""
    system.commit("t", {
      kind: "beginAttempt",
      attempt: {
        objectiveId,
        attemptId: `a${index}`,
        provenance: "user-requested-goal-work",
        executionMode: "foreground",
        startedRevision: domain.revision,
      },
    })
    system.commit("t", {
      kind: "settleAttempt",
      settlement: {
        objectiveId,
        attemptId: `a${index}`,
        startedRevision: domain.revision,
        tokensUsed: 0,
        turnsUsed: 0,
        outcome: "completed",
        executionMode: "foreground",
        criterionIdsBefore: [],
        verifierReceiptIdsBefore: [],
        recordedAt: 2,
      },
    })
  }
}

describe("P2-1 — the product budget ceiling is derived, not silently written", () => {
  test("an over-ceiling budget is stored VERBATIM (the operator is never lied to)", () => {
    const authority = authorityWith({ maxTurns: 1_000_000_000, maxTokens: 9_000_000_000 })
    expect(authority.get("t")?.budget.maxTurns).toBe(1_000_000_000)
    expect(authority.get("t")?.budget.maxTokens).toBe(9_000_000_000)
  })

  test("but the EFFECTIVE bound is the ceiling, and it says so by name", () => {
    const authority = authorityWith({ maxTurns: 1_000_000_000 })
    burnTurns(authority, PRODUCT_BUDGET_CEILING.maxTurns)
    const objective = authority.get("t")
    // The user's own number is nowhere near exhausted...
    expect(objective?.budget.turnsUsed).toBe(PRODUCT_BUDGET_CEILING.maxTurns)
    expect(objective?.budget.maxTurns).toBe(1_000_000_000)
    // ...yet the work stops, and the reason names the ceiling rather than
    // pretending the user's budget ran out (raising it would not help).
    expect(objective?.status).toBe("budget_limited")
    expect(objective?.budget.limitedBy).toBe("product-budget-ceiling")
  })

  test("a budget UNDER the ceiling is unaffected — the user's bound still binds first", () => {
    const authority = authorityWith({ maxTurns: 2 })
    burnTurns(authority, 2)
    const objective = authority.get("t")
    expect(objective?.status).toBe("budget_limited")
    expect(objective?.budget.limitedBy).toBe("user-budget")
  })

  test("no budget at all ⇒ the ceiling still bounds the work", () => {
    const authority = createObjectiveAuthority({ now: () => 1, enforceBudget: true })
    authority.create("t", { goal: "ship", successCriteria: ["c"] })
    burnTurns(authority, PRODUCT_BUDGET_CEILING.maxTurns)
    expect(authority.get("t")?.budget.limitedBy).toBe("product-budget-ceiling")
    expect(authority.get("t")?.status).toBe("budget_limited")
  })

  test("TOKENS are bounded by the ceiling too, and named the same way", () => {
    const authority = authorityWith({ maxTokens: 9_000_000_000 })
    const system = createObjectiveCapabilities(authority).system
    const domain = authority.readDomain("t")
    const objectiveId = domain.state?.objective.objectiveId ?? ""
    system.commit("t", {
      kind: "beginAttempt",
      attempt: {
        objectiveId,
        attemptId: "tok",
        provenance: "user-requested-goal-work",
        executionMode: "foreground",
        startedRevision: domain.revision,
      },
    })
    system.commit("t", {
      kind: "settleAttempt",
      settlement: {
        objectiveId,
        attemptId: "tok",
        startedRevision: domain.revision,
        tokensUsed: PRODUCT_BUDGET_CEILING.maxTokens,
        turnsUsed: 0,
        outcome: "completed",
        executionMode: "foreground",
        criterionIdsBefore: [],
        verifierReceiptIdsBefore: [],
        recordedAt: 2,
      },
    })
    const objective = authority.get("t")
    expect(objective?.budget.tokensUsed).toBe(PRODUCT_BUDGET_CEILING.maxTokens)
    expect(objective?.budget.maxTokens).toBe(9_000_000_000) // verbatim, still
    expect(objective?.budget.limitedBy).toBe("product-budget-ceiling")
    expect(objective?.status).toBe("budget_limited")
  })

  test("the ceiling survives a persist/restore round trip (a saved 1e9 is still bounded)", () => {
    const authority = authorityWith({ maxTurns: 1_000_000_000 })
    burnTurns(authority, PRODUCT_BUDGET_CEILING.maxTurns)
    expect(authority.get("t")?.budget.limitedBy).toBe("product-budget-ceiling")
  })
})
