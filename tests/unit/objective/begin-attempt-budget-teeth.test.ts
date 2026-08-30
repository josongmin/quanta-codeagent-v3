/**
 * ★ HELLGATE (P1-E) — the authority's atomic backstop bounds BOTH counters.
 *
 * `beginAttempt` is documented as the layer that "rechecks both counters
 * atomically before the slot is consumed (the controller precheck is
 * advisory)". It rechecked one. `autonomousAllowance` takes `userMaxTurns` and
 * `turnsUsed` and knows nothing about tokens, so a goal whose TOKEN budget was
 * exhausted kept opening attempts: the store derived `budget_limited` with
 * `limitedBy: "user-budget"` on the very same read, and the authority admitted
 * the next attempt anyway (probe, 2026-08-30: `maxTokens: 100`, 500 spent,
 * autonomous `beginAttempt` ⇒ APPLIED).
 *
 * The same hole swallowed the product ceiling on one goal's spend: with no
 * declared budget `userMaxTurns` is `undefined`, so `userRemaining` is Infinity
 * and nothing bounded the attempt below the product hard cap.
 *
 * The bound the store DERIVES is the one the authority must enforce, so the
 * refusal is now written from `budget.limitedBy` — by construction the two can
 * no longer disagree. The one asymmetry is deliberate and pinned below: the
 * product AUTONOMOUS cap bounds autonomous attempts only; user-requested goal
 * work consumes no product-cap turn.
 */

import { describe, expect, test } from "bun:test"
import {
  createObjectiveAuthority,
  createObjectiveCapabilities,
  type ObjectiveAttemptProvenance,
  PRODUCT_BUDGET_CEILING,
} from "@/objective"

const setup = (opts: { maxTokens?: number; maxTurns?: number; productCap?: number } = {}) => {
  const authority = createObjectiveAuthority({
    now: () => 1,
    enforceBudget: true,
    ...(opts.productCap !== undefined ? { productAutonomousTurnCap: opts.productCap } : {}),
  })
  const budget: { maxTokens?: number; maxTurns?: number } = {}
  if (opts.maxTokens !== undefined) budget.maxTokens = opts.maxTokens
  if (opts.maxTurns !== undefined) budget.maxTurns = opts.maxTurns
  authority.create("t", {
    goal: "g",
    successCriteria: ["c"],
    ...(Object.keys(budget).length > 0 ? { budget } : {}),
  })
  const caps = createObjectiveCapabilities(authority)
  const objectiveId = () => authority.get("t")?.objectiveId ?? ""
  let n = 0
  const begin = (provenance: ObjectiveAttemptProvenance) => {
    n += 1
    return caps.system.commit("t", {
      kind: "beginAttempt",
      attempt: {
        objectiveId: objectiveId(),
        attemptId: `a${n}`,
        provenance,
        executionMode: "foreground",
        startedRevision: authority.readDomain("t").revision,
      },
    })
  }
  /** Close whatever is in flight, spending `tokens`. */
  const settle = (tokens: number) => {
    const attemptId = authority.get("t")?.attempts.started?.attemptId
    if (attemptId === undefined) throw new Error("nothing in flight")
    return caps.system.commit("t", {
      kind: "settleAttempt",
      settlement: {
        objectiveId: objectiveId(),
        attemptId,
        startedRevision: authority.readDomain("t").revision,
        tokensUsed: tokens,
        turnsUsed: 1,
        outcome: "completed",
        executionMode: "foreground",
        criterionIdsBefore: [],
        verifierReceiptIdsBefore: [],
        recordedAt: 2,
      },
    })
  }
  const reasonOf = (res: ReturnType<typeof begin>): string => (res.ok ? "ok" : res.reason)
  return { authority, caps, begin, settle, reasonOf }
}

describe("GOAL P1-E — an exhausted TOKEN budget stops the next attempt", () => {
  test("a declared token budget the goal blew through refuses both provenances", () => {
    const { authority, begin, settle, reasonOf } = setup({ maxTokens: 100 })
    expect(begin("autonomous-continuation").ok).toBe(true)
    expect(settle(500).ok).toBe(true)
    expect(authority.get("t")?.budget.limitedBy).toBe("user-budget")

    expect(reasonOf(begin("autonomous-continuation"))).toBe("budget-exhausted")
    expect(reasonOf(begin("user-requested-goal-work"))).toBe("budget-exhausted")
    expect(authority.get("t")?.attempts.started).toBeUndefined()
  })

  test("the PRODUCT ceiling on one goal's spend binds even above a declared budget", () => {
    const { authority, begin, settle, reasonOf } = setup({
      maxTokens: PRODUCT_BUDGET_CEILING.maxTokens * 2,
    })
    expect(begin("autonomous-continuation").ok).toBe(true)
    expect(settle(PRODUCT_BUDGET_CEILING.maxTokens).ok).toBe(true)
    expect(authority.get("t")?.budget.limitedBy).toBe("product-budget-ceiling")
    // The operator's own number is stored VERBATIM — the ceiling is derived.
    expect(authority.get("t")?.budget.maxTokens).toBe(PRODUCT_BUDGET_CEILING.maxTokens * 2)

    expect(reasonOf(begin("autonomous-continuation"))).toBe("budget-exhausted")
    expect(reasonOf(begin("user-requested-goal-work"))).toBe("budget-exhausted")
  })
})

describe("GOAL P1-E — the bounds that already worked keep working", () => {
  test("PAIRED CONTROL — the product autonomous cap stops autonomous work only", () => {
    const { authority, begin, settle, reasonOf } = setup({ productCap: 2 })
    expect(begin("autonomous-continuation").ok).toBe(true)
    expect(settle(1).ok).toBe(true)
    expect(begin("autonomous-continuation").ok).toBe(true)
    expect(settle(1).ok).toBe(true)
    expect(authority.get("t")?.budget.limitedBy).toBe("product-hard-cap")

    expect(reasonOf(begin("autonomous-continuation"))).toBe("hard-cap-exhausted")
    // A user-requested attempt consumes no product-cap turn: it must still run.
    expect(begin("user-requested-goal-work").ok).toBe(true)
  })

  test("PAIRED CONTROL — inside every bound both provenances still start", () => {
    const { authority, begin, settle, reasonOf } = setup({ maxTokens: 1_000, maxTurns: 10 })
    expect(begin("autonomous-continuation").ok).toBe(true)
    expect(settle(10).ok).toBe(true)
    expect(authority.get("t")?.budget.limitedBy).toBeUndefined()

    expect(reasonOf(begin("autonomous-continuation"))).toBe("ok")
    expect(authority.get("t")?.attempts.started?.attemptId).toBeDefined()
  })

  test("PAIRED CONTROL — an exhausted TURN budget still refuses, as it always did", () => {
    const { authority, begin, settle, reasonOf } = setup({ maxTurns: 1 })
    expect(begin("user-requested-goal-work").ok).toBe(true)
    expect(settle(1).ok).toBe(true)
    expect(authority.get("t")?.budget.limitedBy).toBe("user-budget")

    expect(reasonOf(begin("autonomous-continuation"))).toBe("budget-exhausted")
    expect(reasonOf(begin("user-requested-goal-work"))).toBe("budget-exhausted")
  })
})
