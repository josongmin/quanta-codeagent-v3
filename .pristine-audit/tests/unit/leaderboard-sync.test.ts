import { describe, expect, it } from "bun:test"
import {
  emitRunblock,
  type ReportRow,
  reconcile,
  solvedFromReports,
} from "../../tools/leaderboard-dashboard/leaderboard-sync"

const row = (p: Partial<ReportRow> & { id: string; passed: boolean }): ReportRow => ({
  preset: "agentless-v6-singlepass-execfull",
  model: "gpt-5.5",
  turns: 20,
  ts: 1000,
  ...p,
})

describe("solvedFromReports", () => {
  it("an instance is solved if ANY report passed; ignores non-SWE fixture ids", () => {
    const s = solvedFromReports([
      row({ id: "pydata__xarray-4094", passed: false, turns: 30, ts: 1 }),
      row({ id: "pydata__xarray-4094", passed: true, turns: 21, ts: 2 }),
      row({ id: "a", passed: true }), // fixture id — ignored
      row({ id: "x", passed: true }), // fixture id — ignored
    ])
    expect([...s.keys()]).toEqual(["pydata__xarray-4094"])
  })

  it("receipt = the passing run with FEWEST turns; ties → most recent", () => {
    const s = solvedFromReports([
      row({ id: "django__django-1", passed: true, turns: 40, ts: 5, preset: "v3" }),
      row({ id: "django__django-1", passed: true, turns: 20, ts: 1, preset: "v6" }),
      row({ id: "django__django-1", passed: true, turns: 20, ts: 9, preset: "v6b" }), // tie → newer
    ])
    expect(s.get("django__django-1")).toEqual({
      id: "django__django-1",
      preset: "v6b",
      model: "gpt-5.5",
      turns: 20,
    })
  })

  it("a FAIL-only instance is not solved", () => {
    const s = solvedFromReports([row({ id: "django__django-2", passed: false })])
    expect(s.has("django__django-2")).toBe(false)
  })
})

describe("reconcile", () => {
  const solved = solvedFromReports([
    row({ id: "pydata__xarray-4094", passed: true }),
    row({ id: "django__django-11138", passed: true }),
  ])

  it("MISSING = solved in reports, absent from the leaderboard", () => {
    const { missing } = reconcile(solved, new Set(["django__django-11138"]))
    expect(missing.map((m) => m.id)).toEqual(["pydata__xarray-4094"])
  })

  it("OVERCLAIM = in the leaderboard, no passing report", () => {
    const { overclaim } = reconcile(
      solved,
      new Set(["django__django-11138", "pydata__xarray-4094", "sympy__sympy-99999"]),
    )
    expect(overclaim).toEqual(["sympy__sympy-99999"])
  })

  it("in-sync → both empty", () => {
    const r = reconcile(solved, new Set(["pydata__xarray-4094", "django__django-11138"]))
    expect(r.missing).toEqual([])
    expect(r.overclaim).toEqual([])
  })
})

describe("emitRunblock", () => {
  it("renders an appendable run-block with repo mapping + per-instance receipt", () => {
    const yaml = emitRunblock(
      [
        {
          id: "pydata__xarray-4094",
          preset: "agentless-v6-singlepass-execfull",
          model: "gpt-5.5",
          turns: 21,
        },
      ],
      "2026-06-28",
    )
    expect(yaml).toContain("- run_id: sync-derived-2026-06-28")
    expect(yaml).toContain("instance_id: pydata__xarray-4094")
    expect(yaml).toContain("repo: xarray") // pydata → xarray mapping
    expect(yaml).toContain("turns: 21")
    expect(yaml).toContain("resolved_count: 1")
  })

  it("empty set → an explicit in-sync comment, not a bogus block", () => {
    expect(emitRunblock([], "2026-06-28")).toContain("in sync")
  })
})
