/**
 * ★ HELLGATE (P1-D) — the operator learns WHICH bound stopped the goal, and is
 * not told to do something that cannot work.
 *
 * MEASURED DEFECT (2026-08-30, round-2 audit): the store derives
 * `budget.limitedBy` — `user-budget`, `product-hard-cap`, or
 * `product-budget-ceiling` — precisely so a surface can say whether raising the
 * budget could ever help. Production consumers: zero. `/goal show` printed the
 * counters and not the bound, and `/goal resume` on a `budget_limited` goal
 * printed "Cannot resume: increase budget or edit the goal." unconditionally —
 * which is ACTIVELY WRONG advice under the product hard cap, where no amendment
 * recovers anything. The operator was sent to do the one thing guaranteed to
 * fail.
 *
 * Paired control: under the USER budget "increase the budget" is the correct
 * advice and must survive.
 */

import { describe, expect, test } from "bun:test"
import { goalCmd } from "@/apps/cli/slash/goal-cmd"
import { buildGoalControl } from "@/apps/cli/slash/objective"
import type { SlashContext } from "@/apps/cli/slash-contract"
import {
  createObjectiveAuthority,
  createObjectiveCapabilities,
  type ObjectiveAttemptProvenance,
  type ObjectiveAuthority,
} from "@/objective"

const harness = (opts: { maxTurns?: number; productCap?: number } = {}) => {
  const authority = createObjectiveAuthority({
    now: () => 1,
    enforceBudget: true,
    ...(opts.productCap !== undefined ? { productAutonomousTurnCap: opts.productCap } : {}),
  })
  authority.create("thread", {
    goal: "ship the release",
    successCriteria: ["tests pass"],
    ...(opts.maxTurns !== undefined ? { budget: { maxTurns: opts.maxTurns } } : {}),
  })
  const out: string[] = []
  const err: string[] = []
  const ctx: SlashContext = {
    cwd: "/tmp",
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    objectiveEditor: buildGoalControl(authority, "thread"),
    now: () => 10_000,
  }
  return { authority, ctx, out, err }
}

/** Burn one attributed attempt (begin + settle), the way the host turn does. */
const burnAttempt = (
  authority: ObjectiveAuthority,
  n: number,
  provenance: ObjectiveAttemptProvenance,
): void => {
  const caps = createObjectiveCapabilities(authority)
  const objectiveId = authority.get("thread")?.objectiveId ?? ""
  const attemptId = `a${n}`
  caps.system.commit("thread", {
    kind: "beginAttempt",
    attempt: {
      objectiveId,
      attemptId,
      provenance,
      executionMode: "foreground",
      startedRevision: authority.readDomain("thread").revision,
    },
  })
  caps.system.commit("thread", {
    kind: "settleAttempt",
    settlement: {
      objectiveId,
      attemptId,
      startedRevision: authority.readDomain("thread").revision,
      tokensUsed: 1,
      turnsUsed: 1,
      outcome: "completed",
      executionMode: "foreground",
      criterionIdsBefore: [],
      verifierReceiptIdsBefore: [],
      recordedAt: 2,
    },
  })
}

describe("GOAL P1-D — /goal show names the bound", () => {
  test("an exhausted USER budget is named as the user's own budget", async () => {
    const { authority, ctx, out } = harness({ maxTurns: 1 })
    burnAttempt(authority, 1, "user-requested-goal-work")
    expect(authority.get("thread")?.budget.limitedBy).toBe("user-budget")

    out.length = 0
    await goalCmd.run(["show"], ctx)

    expect(out.join("")).toContain("user-budget")
  })

  test("an exhausted PRODUCT hard cap is named as the product cap", async () => {
    const { authority, ctx, out } = harness({ productCap: 2 })
    burnAttempt(authority, 1, "autonomous-continuation")
    burnAttempt(authority, 2, "autonomous-continuation")
    expect(authority.get("thread")?.budget.limitedBy).toBe("product-hard-cap")

    out.length = 0
    await goalCmd.run(["show"], ctx)

    expect(out.join("")).toContain("product-hard-cap")
  })
})

describe("GOAL P1-D — /goal resume does not give advice that cannot work", () => {
  test("under the product hard cap the operator is NOT told to raise the budget", async () => {
    const { authority, ctx, err } = harness({ productCap: 2 })
    burnAttempt(authority, 1, "autonomous-continuation")
    burnAttempt(authority, 2, "autonomous-continuation")
    expect(authority.get("thread")?.status).toBe("budget_limited")

    err.length = 0
    expect(await goalCmd.run(["resume"], ctx)).toBe(1)

    const text = err.join("")
    expect(text).not.toContain("increase budget")
    expect(text).toContain("cap")
  })

  test("PAIRED CONTROL — under the USER budget, raising it is still the advice", async () => {
    const { authority, ctx, err } = harness({ maxTurns: 1 })
    burnAttempt(authority, 1, "user-requested-goal-work")
    expect(authority.get("thread")?.status).toBe("budget_limited")

    err.length = 0
    expect(await goalCmd.run(["resume"], ctx)).toBe(1)

    expect(err.join("")).toContain("increase budget")
  })
})
