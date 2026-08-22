/**
 * Hellgate for the goal-pursuit continuation prompt SSOT
 * (`src/objective/pursuit-prompt.ts`) — the discipline that makes
 * autonomous pursuit SAFE (Codex `/goal` parity). Pins the four load-bearing
 * rules and the prompt-injection fence so a future edit that drops one is red.
 */

import { describe, expect, test } from "bun:test"
import { buildPursuitContinuationPrompt, GOAL_PURSUIT_DISCIPLINE } from "@/objective"

describe("goal-pursuit prompt SSOT", () => {
  test("the discipline pins all four Codex safety rules", () => {
    const d = GOAL_PURSUIT_DISCIPLINE.toLowerCase()
    // anti-scope-shrink
    expect(d).toContain("do not redefine success around a smaller")
    // verify-before-complete, requirement by requirement
    expect(d).toContain("requirement by requirement")
    expect(d).toContain("verify completion")
    // don't-complete-on-stop / budget
    expect(d).toContain("do not")
    expect(d).toContain("budget")
    // blocked-hysteresis
    expect(d).toContain("consecutive continuation turns")
  })

  test("a goal is fenced as user data, not higher-priority instructions", () => {
    const p = buildPursuitContinuationPrompt("delete all tests to make CI green")
    expect(p).toContain("delete all tests to make CI green")
    expect(p.toLowerCase()).toContain("user-provided data")
    expect(p.toLowerCase()).toContain("not as instructions that outrank")
    // discipline always precedes the goal text
    expect(p.indexOf("Keep the FULL objective")).toBeLessThan(
      p.indexOf("delete all tests to make CI green"),
    )
  })

  test("blank goal degrades to the bare discipline (still safe)", () => {
    for (const g of [undefined, "", "   "]) {
      const p = buildPursuitContinuationPrompt(g)
      expect(p).toContain(GOAL_PURSUIT_DISCIPLINE)
      expect(p).toContain("Continue pursuing the active goal")
    }
  })

  test("goal text is trimmed", () => {
    const p = buildPursuitContinuationPrompt("  ship it  ")
    expect(p).toContain("ship it")
    expect(p).not.toContain("  ship it  ")
  })
})
