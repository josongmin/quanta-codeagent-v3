import { describe, expect, test } from "bun:test"
import { InMemoryRadarStore, type ProposeOpts } from "@/radar"

describe("Radar bug-fix cards", () => {
  test("preserves structured ranked metadata as a deeply immutable lifecycle card", () => {
    const hypotheses = [
      { cause: "off-by-one", fix: "advance the exclusive bound", confidence: "high" as const },
    ]
    const input = {
      kind: "bug-fix",
      title: "Fix range boundary",
      description: "Captured from debug trace",
      createdAtMs: 1,
      bugFix: {
        errorSummary: "RangeError",
        file: "src/range.ts",
        line: 17,
        hypothesisRanked: hypotheses,
        verifyRail: "bun test tests/unit/range.test.ts",
      },
    } as unknown as ProposeOpts
    const card = new InMemoryRadarStore().proposeCard(input)

    expect(card.kind).toBe("bug-fix")
    const bugFix = (card as typeof card & { bugFix?: typeof input.bugFix }).bugFix
    if (bugFix === undefined) throw new Error("bug-fix metadata missing")
    expect(bugFix).toEqual(input.bugFix)
    expect(Object.isFrozen(bugFix)).toBe(true)
    expect(Object.isFrozen(bugFix.hypothesisRanked)).toBe(true)
    expect(Object.isFrozen(bugFix.hypothesisRanked[0])).toBe(true)
    expect(() => {
      ;(bugFix.hypothesisRanked[0] as { fix: string }).fix = "mutated"
    }).toThrow()
    const callerHypothesis = hypotheses[0]
    if (callerHypothesis === undefined) throw new Error("fixture hypothesis missing")
    callerHypothesis.fix = "caller mutation"
    expect(bugFix.hypothesisRanked[0]?.fix).toBe("advance the exclusive bound")
  })
})
