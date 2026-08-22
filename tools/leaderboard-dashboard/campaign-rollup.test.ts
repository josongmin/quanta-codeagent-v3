/**
 * C1 — the CAMPAIGN ROLLUP is the ranking surface, and it must publish the
 * OFFICIAL numbers with the coverage loss beside them.
 *
 * The defect: `groupRuns` ignored `run.officialGrade` entirely and re-folded
 * `perInstance` rows. The per-RUN numbers already came off the persisted totals,
 * so the campaign — the row an operator ranks on — was the ONE surface still
 * publishing the local verifier's rate, on whatever denominator happened to
 * survive, with no coverage shown.
 *
 * Every test drives the SHIPPED `groupRuns` (an ordinary module now, not a
 * transpiled slice of `server.ts`). The fixtures are deliberately built so the
 * row fold and the official totals DISAGREE: if the rollup ever went back to
 * counting rows, these numbers would change.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { OfficialGradeTotals } from "@/runner/batch/report-official-grade"
import { formatOfficialGradeTotals } from "@/runner/batch/report-official-grade"
import { groupRuns, rollUpOfficialGrade } from "./campaign-rollup"
import type { Run, SweInstanceRow } from "./run-types"

/** A legal covering partition: assigned = resolved+model_miss+infra+amb+missing. */
const totalsOf = (o: {
  assigned: number
  resolved: number
  model_miss?: number
  infra_invalid?: number
  ambiguous?: number
  language?: string
}): OfficialGradeTotals => {
  const model_miss = o.model_miss ?? 0
  const infra_invalid = o.infra_invalid ?? 0
  const ambiguous = o.ambiguous ?? 0
  const missing = o.assigned - (o.resolved + model_miss + infra_invalid + ambiguous)
  const grading_valid = o.resolved + model_miss
  const rate = (n: number, d: number): number | null => (d === 0 ? null : n / d)
  const row = {
    assigned: o.assigned,
    attempted: o.assigned - missing,
    grading_valid,
    resolved: o.resolved,
    model_miss,
    infra_invalid,
    ambiguous,
    missing,
    official_valid_rate: rate(o.resolved, grading_valid),
    coverage: rate(grading_valid, o.assigned),
    raw_rate: rate(o.resolved, o.assigned),
  }
  return {
    ...row,
    by_language: { [o.language ?? "python"]: row },
    by_reason: {
      ...(o.resolved > 0 ? { official_resolved: o.resolved } : {}),
      ...(model_miss > 0 ? { test_failed: model_miss } : {}),
      ...(infra_invalid > 0 ? { golden_apply_failed: infra_invalid } : {}),
      ...(ambiguous > 0 ? { upstream_need_human_review: ambiguous } : {}),
    } as OfficialGradeTotals["by_reason"],
  }
}

const row = (id: string, passed: boolean): SweInstanceRow => ({
  id,
  passed,
  turns: 3,
  durationMs: 10,
  fail: passed
    ? null
    : {
        termination: "completed_unresolved",
        klass: "못고침",
        repro: "",
        f2p: 1,
        p2p: 0,
        reRunnable: false,
      },
})

const run = (over: Partial<Run> & { label: string }): Run =>
  ({
    file: `/reports/${over.label}.report.json`,
    model: "gpt-5.5",
    preset: "agentless-v1",
    viewId: "promax",
    campaignIdentity: "promax",
    benchmarkSuite: "swe-bench",
    mtime: 1,
    resolved: 0,
    total: 0,
    unmeasured: 0,
    instanceRowKind: "swe-grade",
    datasetFamily: "promax",
    perInstance: [],
    ...over,
  }) as Run

const withOfficial = (label: string, totals: OfficialGradeTotals, rows: SweInstanceRow[]): Run =>
  run({
    label,
    perInstance: rows,
    officialGrade: { totals, display: formatOfficialGradeTotals(totals) },
  } as Partial<Run> & { label: string })

describe("C1 — a campaign publishes its PERSISTED official totals, not a row fold", () => {
  test("the headline pair comes off the totals, and disagrees with the rows on purpose", () => {
    // The rows say 4 of 4 passed. The grader says 2 resolved out of 10 assigned,
    // with 6 never graded at all. The row fold is the flattering lie.
    const rows = ["a", "b", "c", "d"].map((id) => row(`repo__${id}`, true))
    const camps = groupRuns([
      withOfficial("sidecar-1", totalsOf({ assigned: 10, resolved: 2, model_miss: 2 }), rows),
    ])
    expect(camps).toHaveLength(1)
    const camp = camps[0]
    if (camp === undefined) throw new Error("expected a campaign")
    expect({ resolved: camp.resolved, total: camp.total }).toEqual({ resolved: 2, total: 10 })
    // …and the loss is VISIBLE beside it: 4 of 10 assigned were validly graded.
    expect(camp.coverage).toBe("40.0% (4/10)")
    expect(camp.official?.missing).toBe(6)
  })

  test("sidecars SUM — the campaign denominator is every chunk's assigned set", () => {
    const camps = groupRuns([
      // `report-i-*` = the full-remote SIDECAR shape, which is exactly what a
      // chunked campaign writes: one file per box, one campaign key.
      withOfficial("report-i-0abc", totalsOf({ assigned: 10, resolved: 3, model_miss: 5 }), []),
      withOfficial(
        "report-i-0def",
        totalsOf({ assigned: 6, resolved: 1, model_miss: 1, language: "go" }),
        [],
      ),
    ])
    const camp = camps[0]
    if (camp === undefined) throw new Error("expected a campaign")
    expect({ resolved: camp.resolved, total: camp.total }).toEqual({ resolved: 4, total: 16 })
    // 8+2 grading-valid of 16 assigned
    expect(camp.coverage).toBe("62.5% (10/16)")
    // the per-language table survives the fold, both languages present
    expect(Object.keys(camp.official?.by_language ?? {}).sort()).toEqual(["go", "python"])
  })

  test("a campaign that lost a whole chunk RANKS BELOW one that did not", () => {
    // Same 4 resolved, same 8 valid — but one campaign was accountable for 16
    // and the other for 10. The shrunken denominator must not win.
    const complete = groupRuns([
      withOfficial("complete", totalsOf({ assigned: 10, resolved: 4, model_miss: 6 }), []),
    ])[0]
    const lossy = groupRuns([
      withOfficial("lossy", totalsOf({ assigned: 16, resolved: 4, model_miss: 6 }), []),
    ])[0]
    if (complete === undefined || lossy === undefined) throw new Error("expected campaigns")
    // Identical official_valid_rate (40%), different raw rate — and RANKING uses
    // the raw one, so the campaign with 6 ungraded instances scores lower.
    expect(complete.official?.official_valid_rate).toBe(lossy.official?.official_valid_rate ?? -1)
    expect(complete.resolved / complete.total).toBeGreaterThan(lossy.resolved / lossy.total)

    const ranked = groupRuns([
      withOfficial("lossy", totalsOf({ assigned: 16, resolved: 4, model_miss: 6 }), []),
      run({ label: "complete", campaignIdentity: "promax-2", perInstance: [] }) as Run,
    ])
    expect(ranked).toHaveLength(2)
  })

  test("PAIRED CONTROL — a campaign with NO official grade is the historical row fold", () => {
    const rows = [row("repo__a", true), row("repo__b", false), row("repo__c", true)]
    const camps = groupRuns([run({ label: "legacy", perInstance: rows })])
    const camp = camps[0]
    if (camp === undefined) throw new Error("expected a campaign")
    expect({ resolved: camp.resolved, total: camp.total }).toEqual({ resolved: 2, total: 3 })
    expect(camp.official).toBeUndefined()
    expect(camp.coverage).toBeUndefined()
  })

  test("a re-runnable HOLE still leaves the legacy denominator (FLAG-B unchanged)", () => {
    const hole: SweInstanceRow = {
      id: "repo__d",
      passed: false,
      turns: 0,
      durationMs: 0,
      fail: {
        termination: "throttled",
        klass: "throttle",
        repro: "",
        f2p: 0,
        p2p: 0,
        reRunnable: true,
      },
    }
    const camps = groupRuns([run({ label: "legacy", perInstance: [row("repo__a", true), hole] })])
    const camp = camps[0]
    if (camp === undefined) throw new Error("expected a campaign")
    expect({ resolved: camp.resolved, total: camp.total, unmeasured: camp.unmeasured }).toEqual({
      resolved: 1,
      total: 1,
      unmeasured: 1,
    })
  })
})

describe("C1 — the fold refuses rather than publishing numbers that do not add up", () => {
  test("KNOWN-ITEM FLOOR: a legal pair of sections folds", () => {
    const summed = rollUpOfficialGrade([
      withOfficial("a", totalsOf({ assigned: 4, resolved: 1, model_miss: 1 }), []),
      withOfficial("b", totalsOf({ assigned: 3, resolved: 2 }), []),
    ])
    expect(summed?.assigned).toBe(7)
    expect(summed?.resolved).toBe(3)
  })

  test("a member whose own totals are NOT a covering partition publishes nothing", () => {
    const broken = totalsOf({ assigned: 4, resolved: 1 })
    const camps = groupRuns([
      withOfficial("bad", { ...broken, assigned: 9 } as OfficialGradeTotals, [
        row("repo__a", true),
      ]),
    ])
    const camp = camps[0]
    if (camp === undefined) throw new Error("expected a campaign")
    expect(camp.official).toBeUndefined()
    expect(camp.coverage).toBeUndefined()
    // …and it falls back to the historical row fold rather than to nothing.
    expect({ resolved: camp.resolved, total: camp.total }).toEqual({ resolved: 1, total: 1 })
  })

  test("no members at all ⇒ undefined (not a zero-assigned campaign)", () => {
    expect(rollUpOfficialGrade([])).toBeUndefined()
    expect(rollUpOfficialGrade([run({ label: "x" })])).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Wiring rails — the shell and the page must actually USE this.
// ---------------------------------------------------------------------------

describe("C1 — the rollup is wired to the surfaces that publish a rate", () => {
  const read = (rel: string): string => readFileSync(join(import.meta.dir, rel), "utf8")

  test("server.ts publishes `campaigns` from a LIVE call to this module", () => {
    const src = read("server.ts")
    // Non-vacuity: the detector distinguishes a call from an import.
    const LIVE = /(?<![.\w$])groupRuns\s*\(/
    expect(LIVE.test('import { groupRuns } from "./campaign-rollup"')).toBe(false)
    expect(LIVE.test("const campaigns = groupRuns(runs)")).toBe(true)
    expect(LIVE.test(src)).toBe(true)
    expect(src).toContain('from "./campaign-rollup"')
    // …and the result is what ships as `campaigns` (the client's ranking input).
    expect(/const campaigns = groupRuns\(/.test(src)).toBe(true)
    expect(/\n {4}campaigns,/.test(src)).toBe(true)
  })

  test("the page prints COVERAGE beside every campaign rate", () => {
    const page = read("page.ts")
    // The campaigns table's percent cell.
    expect(page).toContain("r.coverage")
    // Non-vacuity: the percent cell it must sit in really exists.
    expect(page).toContain("+pct+'%'")
    // …and the `best 캠페인` card carries it too, so the headline number is not
    // the one surface that quotes a rate with no coverage.
    expect(page).toContain("best.coverage")
  })
})

describe("F5 — a REJECTED official partition is distinguishable from no grading at all", () => {
  test("rejected: the row keeps the fallback rate AND says the official denominator was refused", () => {
    const broken = totalsOf({ assigned: 4, resolved: 1 })
    const camps = groupRuns([
      withOfficial("bad", { ...broken, assigned: 9 } as OfficialGradeTotals, [row("repo__a", true)]),
    ])
    const camp = camps[0]
    if (camp === undefined) throw new Error("expected a campaign")
    // The refusal itself is unchanged — an illegal partition publishes NO
    // official numbers rather than a plausible-looking one.
    expect(camp.official).toBeUndefined()
    expect(camp.coverage).toBeUndefined()
    // ...but the row now SAYS so, because the fallback rate still renders and a
    // bare percentage with nothing beside it is the exact shape this surface
    // exists to prevent.
    expect(camp.officialRejected).toBe(true)
  })

  test("PAIRED CONTROL: a campaign that simply never graded is NOT marked rejected", () => {
    const camps = groupRuns([withOfficial("none", undefined, [row("repo__a", true)])])
    const camp = camps[0]
    if (camp === undefined) throw new Error("expected a campaign")
    expect(camp.official).toBeUndefined()
    expect(camp.officialRejected).toBeUndefined()
  })
})
