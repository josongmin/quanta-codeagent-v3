import { describe, expect, test } from "bun:test"
import { type BugFixProposalMetadata, InMemoryRadarStore, type ProposeOpts } from "@/radar"

describe("Radar bug-fix cards", () => {
  test("preserves structured ranked metadata as a deeply immutable lifecycle card", () => {
    const hypotheses = [
      { cause: "off-by-one", fix: "advance the exclusive bound", confidence: "high" as const },
    ]
    const bugFix: BugFixProposalMetadata = {
      errorSummary: "RangeError",
      file: "src/range.ts",
      line: 17,
      hypothesisRanked: hypotheses,
      verifyRail: "bun test tests/unit/range.test.ts",
    }
    const input: ProposeOpts = {
      kind: "bug-fix",
      title: "Fix range boundary",
      description: "Captured from debug trace",
      createdAtMs: 1,
      bugFix,
    }
    const card = new InMemoryRadarStore().proposeCard(input)

    expect(card.kind).toBe("bug-fix")
    const storedBugFix = card.bugFix
    if (storedBugFix === undefined) throw new Error("bug-fix metadata missing")
    expect(storedBugFix).toEqual(bugFix)
    expect(Object.isFrozen(storedBugFix)).toBe(true)
    expect(Object.isFrozen(storedBugFix.hypothesisRanked)).toBe(true)
    const storedHypothesis = storedBugFix.hypothesisRanked[0]
    if (storedHypothesis === undefined) throw new Error("stored hypothesis missing")
    expect(Object.isFrozen(storedHypothesis)).toBe(true)
    expect(Reflect.set(storedHypothesis, "fix", "mutated")).toBe(false)
    const callerHypothesis = hypotheses[0]
    if (callerHypothesis === undefined) throw new Error("fixture hypothesis missing")
    callerHypothesis.fix = "caller mutation"
    expect(storedHypothesis.fix).toBe("advance the exclusive bound")
  })
})
