/**
 * aug-22 coverage/denominator audit — C-C and C-D.
 *
 *   C-C  `rollUpOfficialGrade` summed the totals of the members that HAVE a
 *        section and silently excluded the rest. A campaign of eight sidecars
 *        where one carried an official grade published `resolved/assigned` over
 *        that one sidecar — with `members` listing all eight — and the coverage
 *        string was computed over the same fraction. Coverage over a fraction of
 *        the campaign is not coverage: a member with no section is UNCOVERED,
 *        never excluded.
 *
 *   C-D  the pro/live family cards printed the official `resolved/assigned` pair
 *        with no coverage beside it. The C1 fix reached the verified shell card
 *        and the campaigns table and stopped there, and the rail that was
 *        supposed to catch that (`expect(page).toContain("best.coverage")`) was
 *        satisfied by the ONE site that already had it.
 *
 * Every C-D assertion EXECUTES the function the browser receives, extracted out
 * of the real `renderDashboardPage()` bytes — not a source-text match, and not a
 * re-implementation.
 *
 * ⚠️ SPEND SAFETY. Pure functions over in-memory fixtures; no server is started,
 * no artifact is read from disk, nothing provisions or bills.
 */
import { describe, expect, test } from "bun:test"
import type { OfficialGradeTotals } from "@/runner/batch/report-official-grade"
import { formatOfficialGradeTotals } from "@/runner/batch/report-official-grade"
import { groupRuns, rollUpOfficialGrade } from "./campaign-rollup"
import { renderDashboardPage } from "./page"
import {
  clearQuarantine,
  projectReport,
  quarantinedArtifacts,
  recordQuarantine,
} from "./projectors/registry"
import type { Run, SweInstanceRow } from "./run-types"

// ── fixtures (the same shapes campaign-rollup.test.ts uses) ─────────────────

const totalsOf = (o: {
  assigned: number
  resolved: number
  model_miss?: number
  language?: string
}): OfficialGradeTotals => {
  const model_miss = o.model_miss ?? 0
  const missing = o.assigned - (o.resolved + model_miss)
  const grading_valid = o.resolved + model_miss
  const rate = (n: number, d: number): number | null => (d === 0 ? null : n / d)
  const row = {
    assigned: o.assigned,
    attempted: o.assigned - missing,
    grading_valid,
    resolved: o.resolved,
    model_miss,
    infra_invalid: 0,
    ambiguous: 0,
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

// ---------------------------------------------------------------------------
// C-C — coverage is over the WHOLE campaign, not the graded fraction of it
// ---------------------------------------------------------------------------

describe("C-C — a member with no official section is UNCOVERED, not excluded", () => {
  /** One graded sidecar (10 assigned, 8 validly graded) plus two sidecars whose
   *  grader never produced a section at all — 6 more instances the campaign is
   *  accountable for. */
  const CAMPAIGN = (): Run[] => [
    withOfficial("report-i-0aaa", totalsOf({ assigned: 10, resolved: 4, model_miss: 4 }), []),
    run({
      label: "report-i-0bbb",
      perInstance: ["p", "q", "r", "s"].map((i) => row(`x__${i}`, true)),
    }),
    run({ label: "report-i-0ccc", perInstance: ["t", "u"].map((i) => row(`x__${i}`, false)) }),
  ]

  test("the campaign denominator includes the ungraded members' instances", () => {
    const camp = groupRuns(CAMPAIGN())[0]
    if (camp === undefined) throw new Error("expected a campaign")
    expect(camp.members).toHaveLength(3)
    // THE defect: 10 — the assigned set of the ONE member that had a section,
    // while the campaign row said it rolled up three files.
    expect(camp.total).toBe(16)
    expect(camp.resolved).toBe(4)
  })

  test("the COVERAGE string falls to the whole-campaign figure", () => {
    const camp = groupRuns(CAMPAIGN())[0]
    if (camp === undefined) throw new Error("expected a campaign")
    // 8 validly graded of 16 accountable — NOT 8 of 10.
    expect(camp.coverage).toBe("50.0% (8/16)")
    expect(camp.official?.missing).toBe(8)
  })

  test("a campaign that lost sidecars RANKS BELOW one that did not", () => {
    const lossy = groupRuns(CAMPAIGN())[0]
    const whole = groupRuns([
      withOfficial("report-i-0aaa", totalsOf({ assigned: 10, resolved: 4, model_miss: 4 }), []),
    ])[0]
    if (lossy === undefined || whole === undefined) throw new Error("expected campaigns")
    expect(whole.resolved / whole.total).toBeGreaterThan(lossy.resolved / lossy.total)
  })

  test("PAIRED CONTROL — every member graded ⇒ byte-identical to before", () => {
    const camp = groupRuns([
      withOfficial("report-i-0aaa", totalsOf({ assigned: 10, resolved: 4, model_miss: 4 }), []),
      withOfficial(
        "report-i-0bbb",
        totalsOf({ assigned: 6, resolved: 1, model_miss: 1, language: "go" }),
        [],
      ),
    ])[0]
    if (camp === undefined) throw new Error("expected a campaign")
    expect({ resolved: camp.resolved, total: camp.total }).toEqual({ resolved: 5, total: 16 })
    expect(camp.coverage).toBe("62.5% (10/16)")
  })

  test("PAIRED CONTROL — a campaign with NO official member stays the row fold", () => {
    // Non-vacuity for the clause above: "uncovered" contributions are added only
    // to a campaign that HAS official numbers. A campaign that never ran a grader
    // must not acquire a fabricated 0/N official section.
    const camp = groupRuns([run({ label: "legacy", perInstance: [row("x__a", true)] })])[0]
    if (camp === undefined) throw new Error("expected a campaign")
    expect(camp.official).toBeUndefined()
    expect(camp.coverage).toBeUndefined()
    expect({ resolved: camp.resolved, total: camp.total }).toEqual({ resolved: 1, total: 1 })
    expect(rollUpOfficialGrade([run({ label: "x" })])).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// C-D — every surface that prints the pair prints coverage beside it
// ---------------------------------------------------------------------------

/** The REAL page bytes the browser receives. */
const PAGE = renderDashboardPage({ tracePort: 4318 })

/** Brace-match a `function name(` declaration out of the shipped page. */
const extractFn = (name: string): string => {
  const start = PAGE.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`fn ${name} not found in the shipped page`)
  let depth = 0
  for (let i = PAGE.indexOf("{", start); i < PAGE.length; i += 1) {
    if (PAGE[i] === "{") depth += 1
    else if (PAGE[i] === "}") {
      depth -= 1
      if (depth === 0) return PAGE.slice(start, i + 1)
    }
  }
  throw new Error(`fn ${name} unbalanced`)
}

const escSource = (): string => {
  const m = PAGE.match(/function esc\([^)]*\)\s*\{[^\n]*\}/)
  if (m === null) throw new Error("esc not found in the shipped page")
  return m[0]
}

/** Run one of the page's own render functions with a minimal DOM. */
const renderInto = (
  sinkId: string,
  fns: readonly string[],
  call: string,
  data: unknown,
): string => {
  let html = ""
  const doc = {
    getElementById(id: string) {
      return {
        set innerHTML(v: string) {
          if (id === sinkId) html = v
        },
        querySelectorAll() {
          return { forEach() {} }
        },
      }
    },
  }
  // The shell prelude every card surface leans on: `esc`, the suite dispatch, and
  // the ONE shared card-list builder that appends refused artifacts. Extracted
  // from the shipped page like everything else here, never re-implemented.
  const src = [
    'var BENCH = "promax";',
    escSource(),
    extractFn("suiteOfView"),
    extractFn("withRefusedCard"),
    ...fns,
    call,
  ].join("\n")
  new Function("DATA", "document", src)(data, doc)
  return html
}

const CAMPAIGN_ROW = {
  key: "promax/gpt-5.5",
  viewId: "promax",
  resolved: 4,
  total: 16,
  coverage: "50.0% (8/16)",
}

const DATA = {
  runs: [{ viewId: "promax", perInstance: [{ id: "x__a", passed: true }] }],
  campaigns: [CAMPAIGN_ROW],
  benchmarks: [{ id: "promax", label: "SWE-bench ProMax", suite: "swe-bench" }],
}

describe("C-D — the family cards print coverage beside the campaign rate", () => {
  test("renderFamCards renders the pair AND its coverage", () => {
    const html = renderInto(
      "cards",
      [extractFn("famOurResults"), extractFn("bestCampaignCard"), extractFn("renderFamCards")],
      "renderFamCards();",
      DATA,
    )
    // Non-vacuity: the pair really is on this card, so the coverage assertion is
    // about the same card and not about some other string on the page.
    expect(html).toContain("4/16")
    expect(html).toContain("50.0% (8/16)")
  })

  test("a campaign with NO coverage still renders (the pair is never dropped)", () => {
    const html = renderInto(
      "cards",
      [extractFn("famOurResults"), extractFn("bestCampaignCard"), extractFn("renderFamCards")],
      "renderFamCards();",
      { ...DATA, campaigns: [{ ...CAMPAIGN_ROW, coverage: undefined }] },
    )
    expect(html).toContain("4/16")
    expect(html).not.toContain("커버리지")
  })

  test("the benchmark selector badge carries coverage too", () => {
    const html = renderInto(
      "benchsel",
      [extractFn("benchLabel"), extractFn("renderBenchSel")],
      "renderBenchSel();",
      DATA,
    )
    expect(html).toContain("4/16")
    expect(html).toContain("50.0% (8/16)")
  })

  test("ONE spelling — every `best campaign` card comes from the shared builder", () => {
    // The rail C-D exists to fix was `expect(page).toContain("best.coverage")`,
    // which one already-fixed site satisfied for every other site. Bind the
    // SHARED builder instead, and assert no card re-spells the pair by hand.
    const builder = extractFn("bestCampaignCard")
    expect(builder).toContain("coverage")
    for (const fn of ["renderCards", "renderFamCards"]) {
      const src = extractFn(fn)
      expect({ fn, callsBuilder: /bestCampaignCard\s*\(/.test(src) }).toEqual({
        fn,
        callsBuilder: true,
      })
      // …and does NOT re-derive the pair locally (the drift that produced C-D).
      expect({ fn, respells: /best\.resolved/.test(src) }).toEqual({ fn, respells: false })
    }
  })
})

// ---------------------------------------------------------------------------
// C-C residual — a REFUSED artifact leaves the denominator; make the loss visible
// ---------------------------------------------------------------------------

/**
 * C-C closed the case where a campaign member carried no official section: its
 * instances now enter the denominator as `missing`. But there is a SECOND way a
 * member leaves the campaign entirely — it is REFUSED at the identity boundary,
 * so `buildRunFromFile` returns null, no `Run` exists, and the file appears in
 * neither `members` nor the denominator. The campaign's coverage string then
 * describes the surviving files only: the exact defect C-C is named for, arriving
 * through the refusal channel.
 *
 * C-B WIDENED that channel — a section that cannot be reconciled against its own
 * run rows is now refused at decode — so this is not a hypothetical.
 *
 * The registry's contract is that a refused artifact contributes no run, no
 * campaign and no score, and that its suite claims it so a view can render a
 * VISIBLE diagnostic. The SWE projector declared no claim at all, so every SWE
 * refusal was unclaimed AND unrendered: silent in both directions.
 */
describe("C-C residual — SWE refusals are claimed and rendered beside the rate", () => {
  /** Exactly what `buildRunFromFile` does with a report it cannot project. */
  const refuseAndRecord = (file: string, doc: Record<string, unknown>): void => {
    let refused: unknown
    try {
      projectReport(doc)
    } catch (error) {
      refused = error
    }
    if (refused === undefined) throw new Error(`${file} was NOT refused — the fixture is stale`)
    recordQuarantine(file, doc, refused)
  }

  test("a refusal with EXPLICIT swe identity is claimed by the SWE suite", () => {
    clearQuarantine()
    refuseAndRecord("/reports/report-i-0aaa.report.json", {
      benchmarkSuite: "swe-bench",
      datasetFamily: "not-a-family",
      perInstance: [{ id: "x__a", passed: true }],
    })
    expect(quarantinedArtifacts().map((q) => q.suite)).toEqual(["swe-bench"])
    clearQuarantine()
  })

  test("a refusal carrying only the OFFICIAL-GRADE provenance marker is claimed too", () => {
    // No `benchmarkSuite` key — the legacy encoding, which is what the C-B
    // refusal class looks like on disk. `officialGrade` is written by the SWE
    // branch and by nothing else, so it is this suite's own provenance marker.
    clearQuarantine()
    refuseAndRecord("/reports/legacy.report.json", {
      officialGrade: { totals: { assigned: 3 } },
      perInstance: [{ id: "x__a", passed: true }],
    })
    expect(quarantinedArtifacts().map((q) => q.suite)).toEqual(["swe-bench"])
    clearQuarantine()
  })

  test("PAIRED CONTROL — a TERMINAL refusal is NOT claimed by the SWE suite", () => {
    // Non-vacuity: the claim above is identity-driven, not "SWE claims whatever
    // is left". A terminal artifact stays terminal.
    clearQuarantine()
    refuseAndRecord("/reports/tb.report.json", { trials: [], benchmarkVersion: "9.9" })
    expect(quarantinedArtifacts().map((q) => q.suite)).toEqual(["terminal-bench"])
    clearQuarantine()
  })

  const QUARANTINED = [
    {
      file: "/reports/report-i-0aaa.report.json",
      reason: "i-4 appear(s) in neither",
      suite: "swe-bench",
    },
    {
      file: "/reports/report-i-0bbb.report.json",
      reason: "unknown datasetFamily",
      suite: "swe-bench",
    },
  ]

  const cardsWith = (fn: string, quarantine: unknown[]): string =>
    renderInto(
      "cards",
      [extractFn("famOurResults"), extractFn("bestCampaignCard"), extractFn(fn)],
      `${fn}();`,
      { ...DATA, quarantine },
    )

  test("the family cards show the refused COUNT beside the campaign rate", () => {
    const html = cardsWith("renderFamCards", QUARANTINED)
    // Non-vacuity: the rate really is on this card set, so the refusal card is
    // adjacent to it and not merely somewhere on the page.
    expect(html).toContain("4/16")
    expect(html).toContain("거부된 리포트")
    expect(html).toContain(">2<")
    // …and it says WHY, naming the file, so the operator can act on it.
    expect(html).toContain("report-i-0aaa.report.json")
  })

  test("PAIRED CONTROL — nothing refused ⇒ no card at all (byte-identical)", () => {
    expect(cardsWith("renderFamCards", [])).not.toContain("거부된 리포트")
    // …and a refusal claimed by ANOTHER suite is not this view's loss to show.
    expect(
      cardsWith("renderFamCards", [
        { file: "/reports/tb.report.json", reason: "x", suite: "terminal-bench" },
      ]),
    ).not.toContain("거부된 리포트")
  })

  test("KNOWN-ITEM FLOOR — every card sink in the shipped page accounts for refusals", () => {
    // The C-D defect was a card surface the fix did not reach. Enumerate the
    // surfaces STRUCTURALLY — every function in the bytes the browser receives
    // that writes the `cards` sink — so a NEW one cannot be silently exempt.
    const sinks: string[] = []
    const decl = /function\s+([A-Za-z0-9_$]+)\s*\(/g
    for (let m = decl.exec(PAGE); m !== null; m = decl.exec(PAGE)) {
      const name = m[1]
      if (name === undefined) continue
      const body = extractFn(name)
      if (/getElementById\(\s*["']cards["']\s*\)/.test(body)) sinks.push(name)
    }
    // Floor: the verified shell, the pro/live family shell, the ProMax family
    // view and the Terminal suite view. Four surfaces print a headline today.
    expect(sinks.length).toBeGreaterThanOrEqual(4)
    for (const name of sinks) {
      const body = extractFn(name)
      // Either it appends through the ONE shared builder, or it renders its own
      // suite's refusals (Terminal does). What it may NOT do is ignore them.
      expect({
        name,
        accountsForRefusals: /withRefusedCard\s*\(/.test(body) || /[qQ]uarantine/.test(body),
      }).toEqual({ name, accountsForRefusals: true })
    }
  })
})
