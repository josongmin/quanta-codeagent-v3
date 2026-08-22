import { describe, expect, test } from "bun:test"
import { campaignKeyOf } from "./family-partition"

describe("campaignKeyOf — suite/family partition (RFC jun-29 R4 · BFND-03)", () => {
  const base = { file: "/x/runs/report.json", label: "my-run", model: "gpt-5.5" }

  test("empty identity (verified) ⇒ NO prefix (byte-identical legacy campaign key)", () => {
    expect(campaignKeyOf({ ...base, campaignIdentity: "" })).toBe("my-run")
  })

  test("pro / live ⇒ [family] prefix (their own campaigns)", () => {
    expect(campaignKeyOf({ ...base, campaignIdentity: "pro" })).toBe("[pro] my-run")
    expect(campaignKeyOf({ ...base, campaignIdentity: "live" })).toBe("[live] my-run")
  })

  // The whole point of R4: a pro run of the SAME instance/campaign must NOT share a key
  // with the verified run (else groupRuns unions them → averaged resolved-rate).
  test("verified vs pro of the same run ⇒ DIFFERENT keys (no conflation)", () => {
    expect(campaignKeyOf({ ...base, campaignIdentity: "" })).not.toBe(
      campaignKeyOf({ ...base, campaignIdentity: "pro" }),
    )
  })

  // BFND-03: the key starts with SUITE identity, so a Terminal run can never roll
  // up with a SWE run that happens to share a label.
  test("a suite identity segment partitions across benchmarks", () => {
    expect(campaignKeyOf({ ...base, campaignIdentity: "terminal-bench@2.1 tb-ref#1" })).toBe(
      "[terminal-bench@2.1 tb-ref#1] my-run",
    )
    expect(campaignKeyOf({ ...base, campaignIdentity: "terminal-bench@2.1 tb-ref#1" })).not.toBe(
      campaignKeyOf({ ...base, campaignIdentity: "" }),
    )
  })

  test("identity prefix composes with the full-remote sidecar key", () => {
    expect(
      campaignKeyOf({
        file: "/x/camp/report-i-abc.json",
        label: "report-i-abc",
        model: "m",
        campaignIdentity: "pro",
      }),
    ).toBe("[pro] camp · full-remote (m)")
  })
})
