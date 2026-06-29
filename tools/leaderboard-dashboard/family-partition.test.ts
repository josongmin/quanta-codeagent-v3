import { describe, expect, test } from "bun:test"
import { campaignKeyOf } from "./family-partition"

describe("campaignKeyOf — dataset-family partition (RFC jun-29 R4)", () => {
  const base = { file: "/x/runs/report.json", label: "my-run", model: "gpt-5.5" }

  test("verified ⇒ NO prefix (byte-identical legacy campaign key)", () => {
    expect(campaignKeyOf({ ...base, datasetFamily: "verified" })).toBe("my-run")
  })

  test("pro / live ⇒ [family] prefix (their own campaigns)", () => {
    expect(campaignKeyOf({ ...base, datasetFamily: "pro" })).toBe("[pro] my-run")
    expect(campaignKeyOf({ ...base, datasetFamily: "live" })).toBe("[live] my-run")
  })

  // The whole point of R4: a pro run of the SAME instance/campaign must NOT share a key
  // with the verified run (else groupRuns unions them → averaged resolved-rate).
  test("verified vs pro of the same run ⇒ DIFFERENT keys (no conflation)", () => {
    expect(campaignKeyOf({ ...base, datasetFamily: "verified" })).not.toBe(
      campaignKeyOf({ ...base, datasetFamily: "pro" }),
    )
  })

  test("family prefix composes with the full-remote sidecar key", () => {
    expect(
      campaignKeyOf({
        file: "/x/camp/report-i-abc.json",
        label: "report-i-abc",
        model: "m",
        datasetFamily: "pro",
      }),
    ).toBe("[pro] camp · full-remote (m)")
  })
})
