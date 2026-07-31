import { describe, expect, test } from "bun:test"
import { buildReport } from "./report"

// R4 (RFC jun-29): the report records its dataset family so verified/live/pro runs
// are distinguishable in the leaderboard SSOT instead of being averaged together.
describe("buildReport — datasetFamily (R4)", () => {
  test("non-verified family ⇒ report.datasetFamily is recorded", () => {
    expect(
      buildReport({ model: "m", provider: "p", n: 1, datasetFamily: "pro" }, []).datasetFamily,
    ).toBe("pro")
    expect(
      buildReport({ model: "m", provider: "p", n: 1, datasetFamily: "live" }, []).datasetFamily,
    ).toBe("live")
  })

  test("verified OR absent ⇒ datasetFamily OMITTED (byte-identical legacy report)", () => {
    expect(
      buildReport({ model: "m", provider: "p", n: 1, datasetFamily: "verified" }, []).datasetFamily,
    ).toBeUndefined()
    expect(buildReport({ model: "m", provider: "p", n: 1 }, []).datasetFamily).toBeUndefined()
  })
})
