import { describe, expect, test } from "bun:test"
import { loadGroundingCases } from "@/../src/apps/eval/grounding"

describe("grounding corpus governance", () => {
  // Four committed raw/summary pairs. `bench-*.json` is a local ignored
  // evaluator artifact, never corpus evidence; the loader excludes it so this
  // governance rail is invariant across developer worktrees and clean CI. Pin
  // identities, not only a count: replacement or omission must fail.
  test("canary ships every committed governed raw/summary pair", () => {
    const cases = loadGroundingCases({ suite: "canary" })
    const pairs = new Map<string, Set<string>>()
    for (const groundingCase of cases) {
      if (groundingCase.pairId === undefined || groundingCase.pairRole === undefined) continue
      const roles = pairs.get(groundingCase.pairId) ?? new Set<string>()
      roles.add(groundingCase.pairRole)
      pairs.set(groundingCase.pairId, roles)
    }
    expect([...pairs.keys()].sort()).toEqual([
      "pair-oauth-rerun",
      "pair-prompt-rules-status",
      "pair-screenshot-failure",
      "pair-stale-objective-generation",
    ])
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
