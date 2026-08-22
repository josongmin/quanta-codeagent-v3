/**
 * BFND-03 hellgate — the dashboard's suite-projector registry.
 *
 * Every persisted bench artifact enters the dashboard through ONE dispatch seam
 * keyed on `benchmarkSuite`. Terminal-Bench is a top-level SUITE (it stopped
 * being a fourth `datasetFamily`); ProMax is a future member of the SWE FAMILY
 * axis and must never be admitted as a suite.
 *
 * The fixtures here are REAL artifacts: the canonical Terminal branch is built by
 * the production builder and encoded exactly as `writeReport` lands it on disk,
 * and the legacy branch is the byte-shape `tb-report-emit` wrote before BFND-02.
 */
import { describe, expect, test } from "bun:test"
import { CanonicalReportIdentityError, encodeCanonicalReport } from "@/runner/batch/report-envelope"
import { buildTerminalBenchReport, type TerminalTrialInput } from "@/runner/batch/report-terminal"
import { campaignKeyOf } from "../family-partition"
import {
  benchmarkViewsOf,
  projectorFor,
  projectReport,
  registeredSuites,
  suiteClientAssets,
} from "./registry"
import { registerSweFamilyView, sweFamilyViews } from "./swe-bench/registry"
import { LEGACY_TB_DATASET_REF } from "./terminal-bench"

// ---------------------------------------------------------------------------
// Fixtures — on-disk shapes, not hand-written approximations of them.
// ---------------------------------------------------------------------------

/** A persisted SWE report exactly as the batch writer lands it (legacy encoding:
 *  verified persists NO identity keys at all). */
const sweRaw = (family?: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  timestamp: "2026-08-22T00:00:00.000Z",
  model: "gpt-5.5",
  provider: "openai",
  ...(family !== undefined ? { datasetFamily: family } : {}),
  knobs: { preset: "agentless-v2", resolved: {}, inactive: [] },
  totals: { total: 2, resolved: 1 },
  perInstance: [
    { id: "django__django-1", passed: true, turns: 3, durationMs: 10 },
    { id: "django__django-2", passed: false, turns: 4, durationMs: 20 },
  ],
  ...extra,
})

const TB_TRIALS: readonly TerminalTrialInput[] = [
  { id: "task-a", passed: true, durationMs: 100 },
  { id: "task-b", passed: false, durationMs: 200 },
  { id: "task-c", passed: false, durationMs: 5, error: { kind: "agent-crash" } },
  { id: "task-d", passed: false, durationMs: 900, error: { kind: "agent-timeout" } },
]

/** Canonical Terminal artifact, encoded exactly as it lands on disk. */
const tbCanonicalRaw = (
  datasetRef = "terminal-bench@2.1.0#f00dcafe",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> =>
  JSON.parse(
    JSON.stringify({
      ...encodeCanonicalReport(
        buildTerminalBenchReport(TB_TRIALS, {
          datasetRef,
          timestamp: "2026-08-22T01:00:00.000Z",
          model: "gpt-5.5",
          preset: "TB +levers",
          arm: "levers",
        }),
      ),
      ...overrides,
    }),
  ) as Record<string, unknown>

/** The PRE-BFND-02 Terminal artifact: Terminal rode the family axis as a 4th
 *  "family", with no suite key, no version, no dataset ref and no totals. */
const tbLegacyRaw = (): Record<string, unknown> => ({
  timestamp: "2026-07-03T00:00:00.000Z",
  model: "gpt-5.5",
  datasetFamily: "terminal-bench",
  source: "terminal-bench-harbor",
  arm: "levers",
  knobs: { preset: "TB +levers", resolved: {}, inactive: [] },
  perInstance: TB_TRIALS.map((t) => ({
    id: t.id,
    passed: t.passed,
    turns: 0,
    durationMs: t.durationMs,
    ...(t.error !== undefined ? { error: t.error } : {}),
  })),
})

// ---------------------------------------------------------------------------

describe("BFND-03 registry — registration floor", () => {
  test("both suites are LIVE-registered (not just declared as a constant)", () => {
    const suites = registeredSuites()
    expect(suites.length).toBeGreaterThanOrEqual(2)
    expect([...suites].sort()).toEqual(["swe-bench", "terminal-bench"])
    // A registered suite must resolve to a projector that actually projects.
    for (const suite of suites) expect(projectorFor(suite).suite).toBe(suite)
  })

  test("each suite contributes its own client assets (the render layer is suite-owned)", () => {
    const assets = suiteClientAssets()
    // Terminal owns a real render path; its script must be in the shipped bundle.
    expect(assets.script).toContain("renderTbCards")
    expect(assets.script).toContain("SUITE_VIEWS")
    expect(assets.style).toContain("fam-tb-target")
  })
})

describe("BFND-03 registry — SWE branch dispatch", () => {
  test("legacy identity-less report ⇒ swe-bench / verified / no campaign prefix", () => {
    const p = projectReport(sweRaw())
    expect(p.benchmarkSuite).toBe("swe-bench")
    expect(p.viewId).toBe("verified")
    expect(p.datasetFamily).toBe("verified")
    expect(p.campaignIdentity).toBe("")
    // No suite-owned preset override: the SWE preset label stays server-side.
    expect(p.presetLabel).toBeUndefined()
    // SWE artifacts carry no persisted headline ⇒ the server keeps counting rows.
    expect(p.headline).toBeUndefined()
  })

  test("the FULL family union flows through (not one narrowed literal)", () => {
    for (const family of ["verified", "pro", "live"] as const) {
      const legacy = projectReport(sweRaw(family))
      const explicit = projectReport(sweRaw(family, { benchmarkSuite: "swe-bench" }))
      for (const p of [legacy, explicit]) {
        expect(p.benchmarkSuite).toBe("swe-bench")
        expect(p.viewId).toBe(family)
        expect(p.datasetFamily).toBe(family)
        expect(p.campaignIdentity).toBe(family === "verified" ? "" : family)
      }
    }
  })
})

describe("BFND-03 registry — Terminal branch dispatch", () => {
  test("canonical artifact routes by benchmarkSuite and carries NO family axis", () => {
    const p = projectReport(tbCanonicalRaw())
    expect(p.benchmarkSuite).toBe("terminal-bench")
    expect(p.viewId).toBe("terminal-bench")
    expect(p.datasetFamily).toBeUndefined()
    expect(p.presetLabel).toBe("TB +levers")
  })

  test("campaign identity carries version + pinned dataset ref", () => {
    expect(projectReport(tbCanonicalRaw("ref-one")).campaignIdentity).toBe(
      "terminal-bench@2.1 ref-one",
    )
    // A DIFFERENT pinned dataset is a different campaign — identities never coalesce.
    expect(projectReport(tbCanonicalRaw("ref-two")).campaignIdentity).not.toBe(
      projectReport(tbCanonicalRaw("ref-one")).campaignIdentity,
    )
  })

  test("headline is the PERSISTED metric, not a re-fold of the rows (paired control)", () => {
    const base = tbCanonicalRaw()
    // OFFICIAL-shaped (aug-22): EVERY trial stays in the denominator — the
    // agent-crash is a zero, not a hole ⇒ 1 resolved of 4. This replaced
    // quanta's internal D1 convention, which dropped crashes and thereby
    // inflated the headline; upstream (verified against the pinned
    // `leaderboard/core/metrics.py` in TB21-04) scores a reward-less trial as a
    // miss that remains counted.
    expect(base.totals).toEqual({ total: 4, resolved: 1, resolvedPct: 25 })
    expect(projectReport(base).headline).toEqual({ resolved: 1, total: 4 })

    // CONTROL: flip a row's verdict WITHOUT touching totals. A projector that
    // recomputed the headline from raw rows would move; a formatter cannot.
    const rowsMutated = tbCanonicalRaw()
    ;(rowsMutated.perInstance as { passed: boolean }[])[1]!.passed = true
    expect(projectReport(rowsMutated).headline).toEqual({ resolved: 1, total: 4 })

    // PAIR: move the persisted metric and the headline MUST follow — proving the
    // assertion above is not vacuously pinned to a constant.
    const totalsMutated = tbCanonicalRaw(undefined, {
      totals: { total: 3, resolved: 3, resolvedPct: 100 },
    })
    expect(projectReport(totalsMutated).headline).toEqual({ resolved: 3, total: 3 })
  })

  test("legacy 4th-family artifact still renders — through ONE named legacy adapter", () => {
    const p = projectReport(tbLegacyRaw())
    expect(p.benchmarkSuite).toBe("terminal-bench")
    expect(p.viewId).toBe("terminal-bench")
    // Adapted onto the suite axis: the family key does NOT survive projection.
    expect(p.datasetFamily).toBeUndefined()
    expect(p.campaignIdentity).toBe("terminal-bench@2.1")
    expect(p.campaignIdentity).not.toContain(LEGACY_TB_DATASET_REF)
    // Totals synthesized by the ONE canonical builder ⇒ the same official-shaped
    // rule (every trial counted, crash included).
    expect(p.headline).toEqual({ resolved: 1, total: 4 })
  })
})

describe("BFND-03 registry — fail-closed identity rails", () => {
  const refuses = (raw: unknown): void => {
    expect(() => projectReport(raw)).toThrow(CanonicalReportIdentityError)
  }

  test("ProMax as a TOP-LEVEL suite is refused", () => {
    refuses(sweRaw(undefined, { benchmarkSuite: "promax" }))
    expect(() => projectorFor("promax")).toThrow()
  })

  test("PMX-05: the family axis now ADMITS promax — as a family, never a suite", () => {
    const projected = projectReport(sweRaw("promax"))
    expect(projected.benchmarkSuite).toBe("swe-bench")
    expect(projected.viewId).toBe("promax")
    expect(projected.datasetFamily).toBe("promax")
    // ...and it stays a SEPARATE partition from `pro` (never one campaign space).
    expect(projected.campaignIdentity).toBe("promax")
    expect(projected.campaignIdentity).not.toBe(projectReport(sweRaw("pro")).campaignIdentity)
    // Admission is still fail-closed for a family the registry does NOT admit.
    refuses(sweRaw("promaxx"))
    refuses(sweRaw("prom"))
  })

  test("a terminal report routed through datasetFamily is refused", () => {
    refuses(tbCanonicalRaw(undefined, { datasetFamily: "terminal-bench" }))
    refuses(tbCanonicalRaw(undefined, { datasetFamily: "verified" }))
  })

  test("unknown suite / malformed identity / non-object are refused", () => {
    refuses(sweRaw(undefined, { benchmarkSuite: "swt-bench" }))
    refuses(sweRaw(undefined, { benchmarkSuite: 7 }))
    refuses(tbCanonicalRaw(undefined, { benchmarkVersion: "9.9" }))
    refuses(tbCanonicalRaw(undefined, { datasetRef: "  " }))
    refuses(null)
    refuses([sweRaw()])
    refuses("not-a-report")
  })

  test("HIGH-A: a STRUCTURALLY malformed terminal artifact never reaches a projector", () => {
    // These all keep the three identity fields intact, so only a real validating
    // decode can refuse them. The Terminal projector used to re-check `totals`
    // itself (a consumer compensating for a casting producer); that check is gone,
    // and the boundary below is what holds the line.
    refuses(tbCanonicalRaw(undefined, { totals: { total: "3", resolved: 1, resolvedPct: 33 } }))
    refuses(tbCanonicalRaw(undefined, { totals: undefined }))
    refuses(tbCanonicalRaw(undefined, { totals: { resolved: 1 } }))
    refuses(tbCanonicalRaw(undefined, { perInstance: [{ id: "task-a", passed: true }] }))
    refuses(tbCanonicalRaw(undefined, { perInstance: "task-a,task-b" }))
    refuses(tbCanonicalRaw(undefined, { knobs: { preset: 7, resolved: {}, inactive: [] } }))
    // MED-B: a trial receipt carrying the SWE branch's `error: string`.
    refuses(
      tbCanonicalRaw(undefined, {
        perInstance: [{ id: "task-a", passed: false, turns: 0, durationMs: 1, error: "boom" }],
      }),
    )
    // NON-VACUITY: the same fixture with a VALID terminal fault still projects.
    expect(
      projectReport(
        tbCanonicalRaw(undefined, {
          perInstance: [
            {
              id: "task-a",
              passed: false,
              turns: 0,
              durationMs: 1,
              error: { kind: "agent-crash" },
            },
          ],
        }),
      ).viewId,
    ).toBe("terminal-bench")
  })

  test("mixed report roots: one poisoned artifact never blocks the healthy ones", () => {
    const roots: unknown[] = [
      sweRaw(),
      sweRaw(undefined, { benchmarkSuite: "promax" }),
      tbCanonicalRaw(),
      sweRaw("pro"),
      { junk: true, benchmarkSuite: "terminal-bench" },
    ]
    const projected: string[] = []
    let refused = 0
    for (const raw of roots) {
      try {
        projected.push(projectReport(raw).viewId)
      } catch (err) {
        expect(err).toBeInstanceOf(CanonicalReportIdentityError)
        refused++
      }
    }
    expect(projected).toEqual(["verified", "terminal-bench", "pro"])
    expect(refused).toBe(2)
  })
})

describe("BFND-03 registry — benchmark views", () => {
  test("verified is always offered; other views appear only when seen", () => {
    expect(benchmarkViewsOf([])).toEqual([
      { id: "verified", label: "SWE-bench Verified", suite: "swe-bench" },
    ])
  })

  test("views are suite-tagged and ordered (SWE families first, then Terminal)", () => {
    const views = benchmarkViewsOf(["terminal-bench", "live", "verified", "pro"])
    expect(views.map((v) => v.id)).toEqual(["verified", "pro", "live", "terminal-bench"])
    expect(views.map((v) => v.label)).toEqual([
      "SWE-bench Verified",
      "SWE-bench Pro",
      "SWE-bench Live",
      "Terminal-Bench",
    ])
    expect(views.map((v) => v.suite)).toEqual([
      "swe-bench",
      "swe-bench",
      "swe-bench",
      "terminal-bench",
    ])
  })

  test("an unregistered view id is NOT invented into a benchmark tab", () => {
    expect(benchmarkViewsOf(["definitely-not-a-view"]).map((v) => v.id)).toEqual(["verified"])
  })
})

describe("BFND-03 — the UI-only SWE family-view registry (the PMX-05 seam)", () => {
  test("PMX-05 ships as ONE family registration — a SWE tab, never a suite", () => {
    // Registered by `swe-bench/registry.ts` at import; the tab appears as soon as
    // a promax run is present and nothing else in the dashboard changed.
    expect(sweFamilyViews().some((v) => v.family === "promax")).toBe(true)
    const views = benchmarkViewsOf(["promax"])
    expect(views.map((v) => v.id)).toEqual(["verified", "promax"])
    expect(views.at(-1)).toEqual({ id: "promax", label: "SWE-bench ProMax", suite: "swe-bench" })
    // Absent from the runs ⇒ absent from the tab bar (a family view grants no
    // permanent tab; only the default Verified one is unconditional).
    expect(benchmarkViewsOf([]).map((v) => v.id)).toEqual(["verified"])
    // UI-ONLY: it did NOT become a top-level suite.
    expect([...registeredSuites()].sort()).toEqual(["swe-bench", "terminal-bench"])
    expect(() => projectorFor("promax")).toThrow()
  })

  test("registering a NEW family view adds a SWE-suite tab and nothing else", () => {
    // The seam itself, exercised with a family that does NOT exist — so this test
    // keeps proving the registry works after promax stopped being hypothetical.
    expect(sweFamilyViews().some((v) => v.family === "swt")).toBe(false)
    expect(benchmarkViewsOf(["swt"]).map((v) => v.id)).toEqual(["verified"])

    registerSweFamilyView({ family: "swt", label: "SWT-bench" })

    expect(benchmarkViewsOf(["swt"]).map((v) => v.id)).toEqual(["verified", "swt"])
    // A UI registration grants NO report admission: the decoder still refuses it.
    expect([...registeredSuites()].sort()).toEqual(["swe-bench", "terminal-bench"])
    expect(() => projectReport(sweRaw("swt"))).toThrow(CanonicalReportIdentityError)
  })
})

describe("BFND-03 — cross-suite campaigns never coalesce", () => {
  const keyOf = (label: string, campaignIdentity: string): string =>
    campaignKeyOf({ file: `/runs/${label}.report.json`, label, model: "m", campaignIdentity })

  test("a SWE run and a Terminal run with the SAME label get different campaign keys", () => {
    const swe = projectReport(sweRaw())
    const tb = projectReport(tbCanonicalRaw())
    expect(keyOf("nightly", swe.campaignIdentity)).toBe("nightly")
    expect(keyOf("nightly", tb.campaignIdentity)).toBe(
      "[terminal-bench@2.1 terminal-bench@2.1.0#f00dcafe] nightly",
    )
    expect(keyOf("nightly", swe.campaignIdentity)).not.toBe(keyOf("nightly", tb.campaignIdentity))
  })

  test("two SWE families with the same label never coalesce (R4 preserved)", () => {
    const verified = projectReport(sweRaw("verified"))
    const pro = projectReport(sweRaw("pro"))
    expect(keyOf("solver-x", verified.campaignIdentity)).toBe("solver-x")
    expect(keyOf("solver-x", pro.campaignIdentity)).toBe("[pro] solver-x")
  })

  test("two Terminal runs of DIFFERENT pinned datasets never coalesce", () => {
    const a = projectReport(tbCanonicalRaw("ref-a"))
    const b = projectReport(tbCanonicalRaw("ref-b"))
    expect(keyOf("tb-run", a.campaignIdentity)).not.toBe(keyOf("tb-run", b.campaignIdentity))
  })
})
