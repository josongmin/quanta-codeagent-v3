import { describe, expect, test } from "bun:test"
import { type GoalQuiescenceSnapshot, isQuiescent } from "@/apps/cli/repl/goal-quiescence"

const idle = (): GoalQuiescenceSnapshot => ({
  turnActive: false,
  planModeActive: false,
  externalPromptPending: false,
  textPending: false,
  imagePending: false,
  planPending: false,
  followupPending: false,
  approvalPending: false,
  attachingOrClosing: false,
})

describe("goal quiescence projection", () => {
  test("is true only when all nine host activity sources are absent", () => {
    expect(isQuiescent(idle())).toBe(true)
    for (const key of Object.keys(idle()) as Array<keyof GoalQuiescenceSnapshot>) {
      expect(isQuiescent({ ...idle(), [key]: true })).toBe(false)
    }
  })
})
