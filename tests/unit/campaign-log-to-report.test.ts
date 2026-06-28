import { describe, expect, it } from "bun:test"
import {
  buildReport,
  dedupVerdicts,
  modelFromLog,
  parseCampaignVerdicts,
} from "../../tools/leaderboard-dashboard/campaign-log-to-report"

const LOG = `
[info] [box] bench(swebench): 6 task(s), provider=chatgpt-oauth, model=gpt-5.5, n=1
[info] [box] ▶ pydata__xarray-4094 — repo prep → patch-gen → grade ...
[info] [box] ■ pydata__xarray-4094 PASS — patch=606B turns=21 404s
[info] [box] ■ pydata__xarray-2905 FAIL — patch=553B turns=31 684s
[info] [box] noise line that is not a verdict
`

describe("parseCampaignVerdicts", () => {
  it("extracts every ■ verdict with patch + turns", () => {
    const v = parseCampaignVerdicts(LOG)
    expect(v).toEqual([
      { id: "pydata__xarray-4094", passed: true, patchBytes: 606, turns: 21 },
      { id: "pydata__xarray-2905", passed: false, patchBytes: 553, turns: 31 },
    ])
  })
  it("ignores logs with no verdict lines", () => {
    expect(parseCampaignVerdicts("just some text\n■ not a real verdict\n")).toEqual([])
  })
})

describe("dedupVerdicts", () => {
  it("PASS on ANY relaunch wins over an earlier FAIL", () => {
    const v = dedupVerdicts([
      { id: "django__django-1", passed: false, patchBytes: 100, turns: 30 },
      { id: "django__django-1", passed: true, patchBytes: 200, turns: 25 },
    ])
    expect(v).toEqual([{ id: "django__django-1", passed: true, patchBytes: 200, turns: 25 }])
  })
  it("among same pass-state, fewest turns wins", () => {
    const v = dedupVerdicts([
      { id: "x__x-1", passed: true, patchBytes: 1, turns: 40 },
      { id: "x__x-1", passed: true, patchBytes: 2, turns: 20 },
    ])
    expect(v[0]?.turns).toBe(20)
  })
  it("a FAIL-only instance stays FAIL", () => {
    const v = dedupVerdicts([{ id: "x__x-2", passed: false, patchBytes: 1, turns: 5 }])
    expect(v).toEqual([{ id: "x__x-2", passed: false, patchBytes: 1, turns: 5 }])
  })
})

describe("buildReport", () => {
  it("shapes a real report.json (perInstance + knobs.preset + model + provenance)", () => {
    const r = buildReport(
      [{ id: "pydata__xarray-4094", passed: true, patchBytes: 606, turns: 21 }],
      {
        preset: "agentless-v6-singlepass-execfull",
        model: "gpt-5.5",
        timestamp: "2026-06-28T00:00:00Z",
      },
    )
    expect(r.knobs.preset).toBe("agentless-v6-singlepass-execfull")
    expect(r.model).toBe("gpt-5.5")
    expect(r.source).toBe("recovered-from-campaign-log")
    expect(r.perInstance[0]).toEqual({
      id: "pydata__xarray-4094",
      passed: true,
      patchBytes: 606,
      turns: 21,
    })
  })
})

describe("modelFromLog", () => {
  it("recovers the model id", () => {
    expect(modelFromLog(LOG)).toBe("gpt-5.5")
    expect(modelFromLog("no model here")).toBeUndefined()
  })
})
