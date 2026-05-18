import { describe, expect, test } from "bun:test"
import { isMutatingToolBlockedInPlan, planSystemAugmentation } from "@/agent"
import type { ToolAction } from "@/permission"

describe("plan mode", () => {
  test("augmentation instructs read-only exploration and a concrete plan", () => {
    const s = planSystemAugmentation()
    expect(s.toLowerCase()).toContain("plan mode")
    expect(s.toLowerCase()).toContain("read-only")
    expect(s.toLowerCase()).toContain("do not modify")
    expect(s.toLowerCase()).toContain("step-by-step")
    // stable, non-empty, deterministic
    expect(planSystemAugmentation()).toBe(s)
    expect(s.length).toBeGreaterThan(0)
  })

  test("isMutatingToolBlockedInPlan: true for non-read-only", () => {
    const action: ToolAction = { tool: "write", input: {}, isReadOnly: false }
    expect(isMutatingToolBlockedInPlan(action)).toBe(true)
  })

  test("isMutatingToolBlockedInPlan: false for read-only", () => {
    const action: ToolAction = { tool: "read", input: {}, isReadOnly: true }
    expect(isMutatingToolBlockedInPlan(action)).toBe(false)
  })
})
