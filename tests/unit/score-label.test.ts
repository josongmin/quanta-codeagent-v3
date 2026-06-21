import { describe, expect, it } from "bun:test"
import {
  canPromoteLabel,
  countsAsOfficialClean,
  labelForReceipt,
  officialCleanCount,
  type ScoreLabel,
  weakestLabel,
} from "@/runner/batch/eval/score-label"

describe("score-label taxonomy (T-RESOLVE-14)", () => {
  it("labelForReceipt picks the WEAKEST justified claim", () => {
    expect(
      labelForReceipt({
        officialHarnessResolved: true,
        localExecutedGreen: true,
        researchKnobTouched: false,
      }),
    ).toBe("official_harness")
    expect(
      labelForReceipt({
        officialHarnessResolved: false,
        localExecutedGreen: true,
        researchKnobTouched: false,
      }),
    ).toBe("local_structural")
    // no positive executed evidence ⇒ NOT clean
    expect(
      labelForReceipt({
        officialHarnessResolved: false,
        localExecutedGreen: false,
        researchKnobTouched: false,
      }),
    ).toBe("research_contaminated")
  })

  it("research contamination DOMINATES even an official harness resolve", () => {
    expect(
      labelForReceipt({
        officialHarnessResolved: true,
        localExecutedGreen: true,
        researchKnobTouched: true,
      }),
    ).toBe("research_contaminated")
  })

  it("weakestLabel returns the lowest-rank input; empty ⇒ research_contaminated", () => {
    expect(weakestLabel(["official_harness", "local_structural"])).toBe("local_structural")
    expect(weakestLabel(["official_harness", "research_contaminated"])).toBe(
      "research_contaminated",
    )
    expect(weakestLabel(["official_harness"])).toBe("official_harness")
    expect(weakestLabel([])).toBe("research_contaminated")
  })

  it("HELLGATE: only official_harness counts as clean; the others NEVER do", () => {
    expect(countsAsOfficialClean("official_harness")).toBe(true)
    expect(countsAsOfficialClean("local_structural")).toBe(false)
    expect(countsAsOfficialClean("research_contaminated")).toBe(false)
  })

  it("HELLGATE: headline count = number of official_harness receipts (computed, not hand-edited)", () => {
    const labels: ScoreLabel[] = [
      "official_harness",
      "local_structural",
      "official_harness",
      "research_contaminated",
    ]
    expect(officialCleanCount(labels)).toBe(2)
  })

  it("HELLGATE: no silent upgrade — promotion needs the actual stronger evidence", () => {
    // local green alone cannot promote to official_harness.
    expect(
      canPromoteLabel("official_harness", {
        officialHarnessResolved: false,
        localExecutedGreen: true,
        researchKnobTouched: false,
      }),
    ).toBe(false)
    // with a real harness run it can.
    expect(
      canPromoteLabel("official_harness", {
        officialHarnessResolved: true,
        localExecutedGreen: true,
        researchKnobTouched: false,
      }),
    ).toBe(true)
    // research contamination forbids any upgrade above research_contaminated.
    expect(
      canPromoteLabel("local_structural", {
        officialHarnessResolved: true,
        localExecutedGreen: true,
        researchKnobTouched: true,
      }),
    ).toBe(false)
  })
})
