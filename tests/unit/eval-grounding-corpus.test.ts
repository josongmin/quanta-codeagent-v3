import { describe, expect, test } from "bun:test"
import { loadGroundingCases } from "@/../src/apps/eval/grounding"

describe("grounding corpus governance", () => {
  test("canary ships four raw/summary pair groups", () => {
    const cases = loadGroundingCases({ suite: "canary" })
    const pairs = new Map<string, Set<string>>()
    for (const groundingCase of cases) {
      if (groundingCase.pairId === undefined || groundingCase.pairRole === undefined) continue
      const roles = pairs.get(groundingCase.pairId) ?? new Set<string>()
      roles.add(groundingCase.pairRole)
      pairs.set(groundingCase.pairId, roles)
    }
    expect(pairs.size).toBe(4)
    for (const roles of pairs.values()) {
      expect([...roles].sort()).toEqual(["raw", "summary"])
    }
  })

  test("nightly extra cases are medium-severity only", () => {
    const cases = loadGroundingCases({ suite: "nightly" })
    const nightlyOnly = cases.filter((groundingCase) => groundingCase.severity === "medium")
    expect(nightlyOnly).toHaveLength(24)
  })
})
