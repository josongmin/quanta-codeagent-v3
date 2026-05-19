import { describe, expect, test } from "bun:test"
import { isMutatingToolBlockedInPlan } from "@/agent"
import type { ToolAction } from "@/permission"

describe("plan mode", () => {
  test("isMutatingToolBlockedInPlan: true for non-read-only", () => {
    const action: ToolAction = { tool: "write", input: {}, isReadOnly: false }
    expect(isMutatingToolBlockedInPlan(action)).toBe(true)
  })

  test("isMutatingToolBlockedInPlan: false for read-only", () => {
    const action: ToolAction = { tool: "read", input: {}, isReadOnly: true }
    expect(isMutatingToolBlockedInPlan(action)).toBe(false)
  })
})
