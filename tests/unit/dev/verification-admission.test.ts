import { describe, expect, test } from "bun:test"
import { consumeWait, remainingBudgetMs } from "../../../tools/dev/verification-admission"

describe("single admission budget", () => {
  test("a nested wait cannot mint a new budget", () => {
    let now = 90
    const budget = { deadlineMs: 100, now: () => now }
    expect(remainingBudgetMs(budget)).toBe(10)
    const first = consumeWait(budget, 50)
    expect(first).toEqual({ kind: "admitted", remainingMs: 10 })
    now = 100
    expect(consumeWait(budget, 50)).toEqual({
      kind: "deferred",
      reason: "budget-exhausted",
      remainingMs: 0,
    })
  })
})
