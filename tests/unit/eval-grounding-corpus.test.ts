import { describe, expect, test } from "bun:test"
import { loadGroundingCases } from "@/../src/apps/eval/grounding"

describe("grounding corpus governance", () => {
  // four → five (aug-26): `pair-stale-objective-generation` landed with the
  // goal-control evidence work. Both roles are still required per pair, so the
  // count change cannot smuggle in a half-formed pair.
  test("canary ships five raw/summary pair groups", () => {
    const cases = loadGroundingCases({ suite: "canary" })
    const pairs = new Map<string, Set<string>>()
    for (const groundingCase of cases) {
      if (groundingCase.pairId === undefined || groundingCase.pairRole === undefined) continue
      const roles = pairs.get(groundingCase.pairId) ?? new Set<string>()
      roles.add(groundingCase.pairRole)
      pairs.set(groundingCase.pairId, roles)
    }
    expect(pairs.size).toBe(5)
    for (const roles of pairs.values()) {
      expect([...roles].sort()).toEqual(["raw", "summary"])
    }
  })

  test("nightly extra cases are medium-severity only", () => {
    const cases = loadGroundingCases({ suite: "nightly" })
    const nightlyOnly = cases.filter((groundingCase) => groundingCase.severity === "medium")
    expect(nightlyOnly).toHaveLength(24)
  })

  test("canary preserves critical cases for every bucket-hard gate class", () => {
    const cases = loadGroundingCases({ suite: "canary" })
    const counts = new Map<string, number>()
    for (const groundingCase of cases) {
      if (groundingCase.severity !== "critical") continue
      counts.set(groundingCase.bucket, (counts.get(groundingCase.bucket) ?? 0) + 1)
    }
    expect(counts.get("must_clarify") ?? 0).toBeGreaterThan(0)
    expect(counts.get("stale_context_trap") ?? 0).toBeGreaterThan(0)
    expect(counts.get("summary_equivalence") ?? 0).toBeGreaterThan(0)
    expect(counts.get("wrong_thread_adversarial") ?? 0).toBeGreaterThan(0)
  })
})
