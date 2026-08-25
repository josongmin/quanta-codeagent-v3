/**
 * GOAL-06 — the product autonomous hard cap lives in the AUTHORITY:
 *   - `beginAttempt` for an autonomous attempt atomically rechecks BOTH counters
 *     (`hard-cap-exhausted` / `budget-exhausted`) before the slot is consumed;
 *   - on exhaustion the enforcing store derives `budget_limited` with the
 *     limiting source (`user-budget` | `product-hard-cap`);
 *   - a user-requested attempt consumes no product-cap turn;
 *   - a budget amendment recovers user-limit exhaustion, never the product cap;
 *   - the cap can be injected LOWER (tests) but never above the product value.
 */

import { describe, expect, test } from "bun:test"
import {
  createObjectiveAuthority,
  createObjectiveCapabilities,
  GOAL_PRODUCT_AUTONOMOUS_TURN_CAP,
  type ObjectiveAttemptProvenance,
} from "@/objective"

const setup = (opts: { productCap?: number; maxTurns?: number; enforce?: boolean } = {}) => {
  const authority = createObjectiveAuthority({
    now: () => 1,
    enforceBudget: opts.enforce ?? true,
    ...(opts.productCap !== undefined ? { productAutonomousTurnCap: opts.productCap } : {}),
  })
  authority.create("t", {
    goal: "g",
    successCriteria: ["c"],
    ...(opts.maxTurns !== undefined ? { budget: { maxTurns: opts.maxTurns } } : {}),
  })
  const caps = createObjectiveCapabilities(authority)
  let n = 0
  const attempt = (provenance: ObjectiveAttemptProvenance = "autonomous-continuation") => {
    n += 1
    const id = `a${n}`
    const begun = caps.system.commit("t", {
      kind: "beginAttempt",
      attempt: {
        objectiveId: authority.get("t")?.objectiveId ?? "",
        attemptId: id,
        provenance,
        executionMode: "foreground",
        startedRevision: authority.readDomain("t").revision,
      },
    })
    if (!begun.ok) return begun
    return caps.system.commit("t", {
      kind: "settleAttempt",
      settlement: {
        objectiveId: authority.get("t")?.objectiveId ?? "",
        attemptId: id,
        startedRevision: 1,
        tokensUsed: 1,
        turnsUsed: 0,
        outcome: "completed",
        executionMode: "foreground",
        criterionIdsBefore: [],
        verifierReceiptIdsBefore: [],
        recordedAt: 2,
      },
    })
  }
  return { authority, caps, attempt }
}

describe("GOAL-06 — product hard cap in the authority", () => {
  test("rail 3 — no user budget: product cap N gives exactly N autonomous attempts, then budget_limited (product-hard-cap)", () => {
    const { authority, attempt } = setup({ productCap: 3 })
    expect(attempt().ok).toBe(true)
    expect(attempt().ok).toBe(true)
    expect(attempt().ok).toBe(true)
    const fourth = attempt()
    expect(fourth.ok).toBe(false)
    if (!fourth.ok) expect(fourth.reason).toBe("hard-cap-exhausted")
    const o = authority.get("t")
    expect(o?.attempts.autonomousTurnsStarted).toBe(3)
    expect(o?.budget.turnsUsed).toBe(3)
    expect(o?.status).toBe("budget_limited")
    expect(o?.budget.limitedBy).toBe("product-hard-cap")
  })

  test("rail 4 — user max 5 / product cap 3 gives exactly 3", () => {
    const { authority, attempt } = setup({ productCap: 3, maxTurns: 5 })
    for (let i = 0; i < 3; i += 1) expect(attempt().ok).toBe(true)
    const next = attempt()
    expect(next.ok).toBe(false)
    if (!next.ok) expect(next.reason).toBe("hard-cap-exhausted")
    expect(authority.get("t")?.budget.limitedBy).toBe("product-hard-cap")
  })

  test("rail 5 — user max 2 / product cap 20: one user-requested turn leaves one autonomous turn and consumes no cap", () => {
    const { authority, attempt } = setup({ maxTurns: 2 })
    expect(attempt("user-requested-goal-work").ok).toBe(true)
    expect(authority.get("t")?.attempts.autonomousTurnsStarted).toBe(0)
    expect(attempt().ok).toBe(true)
    const third = attempt()
    expect(third.ok).toBe(false)
    if (!third.ok) expect(third.reason).toBe("budget-exhausted")
    const o = authority.get("t")
    expect(o?.status).toBe("budget_limited")
    expect(o?.budget.limitedBy).toBe("user-budget")
    expect(o?.attempts.autonomousTurnsStarted).toBe(1)
  })

  test("rail 12 — a budget amendment recovers user-limit exhaustion but never the product cap", () => {
    const user = setup({ maxTurns: 1 })
    expect(user.attempt().ok).toBe(true)
    expect(user.authority.get("t")?.status).toBe("budget_limited")
    expect(user.caps.user.commit("t", { kind: "amendBudget", budget: { maxTurns: 3 } }).ok).toBe(
      true,
    )
    expect(user.authority.get("t")?.status).toBe("active")
    expect(user.attempt().ok).toBe(true)

    const product = setup({ productCap: 1, maxTurns: 1 })
    expect(product.attempt().ok).toBe(true)
    expect(product.authority.get("t")?.budget.limitedBy).toBe("product-hard-cap")
    expect(
      product.caps.user.commit("t", { kind: "amendBudget", budget: { maxTurns: 50 } }).ok,
    ).toBe(true)
    expect(product.authority.get("t")?.status).toBe("budget_limited")
    expect(product.authority.get("t")?.budget.limitedBy).toBe("product-hard-cap")
    const again = product.attempt()
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.reason).toBe("hard-cap-exhausted")
    // pause / resume cannot reset either counter
    product.authority.setExplicitStatus("t", "paused")
    product.authority.setExplicitStatus("t", "active")
    expect(product.authority.get("t")?.attempts.autonomousTurnsStarted).toBe(1)
    expect(product.authority.get("t")?.status).toBe("budget_limited")
  })

  test("the injected cap can only lower the product value; the default is the product cap", () => {
    const raised = setup({ productCap: 10_000 })
    for (let i = 0; i < GOAL_PRODUCT_AUTONOMOUS_TURN_CAP; i += 1)
      expect(raised.attempt().ok).toBe(true)
    const over = raised.attempt()
    expect(over.ok).toBe(false)
    if (!over.ok) expect(over.reason).toBe("hard-cap-exhausted")
  })

  test("the informational store (enforce off) rechecks the cap at begin but never derives budget_limited", () => {
    const { authority, attempt } = setup({ productCap: 1, enforce: false })
    expect(attempt().ok).toBe(true)
    const second = attempt()
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.reason).toBe("hard-cap-exhausted")
    expect(authority.get("t")?.status).toBe("active")
    expect(authority.get("t")?.budget.limitedBy).toBeUndefined()
  })
})
