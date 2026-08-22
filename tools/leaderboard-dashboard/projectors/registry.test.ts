/**
 * BFND-03 hellgate — the dashboard's suite-projector registry.
 *
 * Every persisted bench artifact enters the dashboard through ONE dispatch seam
 * keyed on `benchmarkSuite`. Terminal-Bench is a top-level SUITE (it stopped
 * being a fourth `datasetFamily`); ProMax is a future member of the SWE FAMILY
 * axis and must never be admitted as a suite.
 *
 * The fixtures here are REAL artifacts: the canonical Terminal branch is built by
 * the production builder (TB21-04's `buildTerminalRunReport`) and encoded exactly
 * as `writeReport` lands it on disk.
 *
 * TB21-04 widened the Terminal branch to the LOSSLESS 2.1 receipt, so the
 * pre-2.1 (versionless TB2.0) encoding no longer has a legacy adapter: those
 * artifacts are QUARANTINED at the identity boundary, which is what both tickets
 * require. The rail that used to assert they still render now asserts they are
 * refused — see "versionless TB2.0 artifacts are quarantined" below.
 */
import { describe, expect, test } from "bun:test"
import {
  CANONICAL_TASK_IDS,
  canonicalTaskRef,
  TERMINAL_BENCH_DATASET,
  TERMINAL_BENCH_DATASET_REF,
} from "@/apps/bench/terminal/dataset"
import {
  buildTerminalRunReport,
  type TerminalTrialOutcome,
  type TerminalTrialRecord,
} from "@/apps/bench/terminal/report"
import { CanonicalReportIdentityError, encodeCanonicalReport } from "@/runner/batch/report-envelope"
import { campaignKeyOf } from "../family-partition"
import {
  benchmarkViewsOf,
  projectorFor,
  projectReport,
  registeredSuites,
  suiteClientAssets,
} from "./registry"
import { registerSweFamilyView, sweFamilyViews } from "./swe-bench/registry"

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

/** Four REAL 2.1 trial receipts, one per canonical task: a graded pass, a
 *  graded fail, an infra crash and an agent timeout. The crash/timeout carry NO
 *  reward, which is exactly why they score zero and stay in the denominator. */
const tbTrial = (
  index: number,
  outcome: TerminalTrialOutcome,
  reward: number | null,
): TerminalTrialRecord => {
  const taskId = CANONICAL_TASK_IDS[index] as string
  return {
    trialId: `trial-${index}`,
    taskId,
    taskName: taskId.split("/")[1] as string,
    taskRef: canonicalTaskRef(taskId) as string,
    datasetSource: TERMINAL_BENCH_DATASET,
    reward,
    outcome,
    startedAt: "2026-08-22T01:00:00.000Z",
    finishedAt: "2026-08-22T01:05:00.000Z",
    durationSec: 300,
    uncachedInputTokens: 1000,
    cachedInputTokens: 100,
    outputTokens: 50,
    costUsd: 0.5,
    configOverrides: [],
    sourcePath: `/jobs/trial-${index}/result.json`,
  }
}

const TB_TRIALS: readonly TerminalTrialRecord[] = [
  tbTrial(0, "graded_pass", 1),
  tbTrial(1, "graded_fail", 0),
  tbTrial(2, "agent_crash", null),
  tbTrial(3, "agent_timeout", null),
]

/**
 * TB21-05 — the TB21-03 run manifest a real 2.1 run always carries. The
 * projector reads the campaign identity (profile / provider / effort / sandbox)
 * out of it and REFUSES a report that cannot supply one, so the fixture has to
 * carry it for the same reason a real artifact does.
 */
const tbManifest = (datasetRef: string): Record<string, unknown> => ({
  schemaVersion: "terminal-bench-run/v2",
  benchmarkSuite: "terminal-bench",
  benchmarkVersion: "2.1",
  dataset: TERMINAL_BENCH_DATASET,
  datasetRef,
  harborVersion: "0.21.0",
  quantaSha: "8cdf4badbe83",
  dirty: false,
  agentVersion: "1.0.025+g8cdf4badbe83",
  profile: "quanta-full",
  model: "gpt-5.5",
  provider: "openai",
  reasoningEffort: "xhigh",
  sandbox: "docker",
  k: 1,
  timestamp: "2026-08-22T01:00:00.000Z",
  arm: "levers",
  preset: "TB +levers",
  promotable: false,
})

/** Canonical Terminal artifact, encoded exactly as it lands on disk. */
const tbCanonicalRaw = (
  datasetRef?: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> =>
  JSON.parse(
    JSON.stringify({
      ...encodeCanonicalReport(
        buildTerminalRunReport({
          datasetRef: TERMINAL_BENCH_DATASET_REF,
          timestamp: "2026-08-22T01:00:00.000Z",
          arm: "levers",
          k: 1,
          harborJobIds: ["job-1"],
          sourcePaths: ["/jobs"],
          model: "gpt-5.5",
          preset: "TB +levers",
          trials: TB_TRIALS,
          defects: [],
        }),
      ),
      manifest: tbManifest(datasetRef ?? TERMINAL_BENCH_DATASET_REF),
      ...(datasetRef !== undefined ? { datasetRef } : {}),
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
  perInstance: [
    { id: "task-a", passed: true, turns: 0, durationMs: 100 },
    { id: "task-b", passed: false, turns: 0, durationMs: 200 },
  ],
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
    expect(assets.style).toContain("tb-prov")
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
    // TB21-05 widened this to the FULL run identity (profile / model / effort /
    // sandbox / k / standard-config); the version + pinned ref stay its head.
    expect(projectReport(tbCanonicalRaw("ref-one")).campaignIdentity).toContain(
      "terminal-bench@2.1 ref-one",
    )
    // A DIFFERENT pinned dataset is a different campaign — identities never coalesce.
    expect(projectReport(tbCanonicalRaw("ref-two")).campaignIdentity).not.toBe(
      projectReport(tbCanonicalRaw("ref-one")).campaignIdentity,
    )
  })

  test("headline is the PERSISTED tally, not a re-fold of the receipts (paired control)", () => {
    const base = tbCanonicalRaw()
    // OFFICIAL-shaped: EVERY trial stays in the denominator — the crash and the
    // timeout are zeros, not holes ⇒ 1 resolved of 4.
    expect(base.outcomes).toMatchObject({ graded_pass: 1, graded_fail: 1, agent_crash: 1 })
    expect((base.metrics as { accuracy: number }).accuracy).toBe(25)
    expect(projectReport(base).headline).toEqual({ resolved: 1, total: 4 })

    // PAIR: move the persisted tally (and the receipts it summarises, because the
    // decode refuses a tally that disagrees with them) and the headline MUST
    // follow — proving the assertion above is not pinned to a constant.
    const morePasses = tbCanonicalRaw(undefined, {
      ...encodeCanonicalReport(
        buildTerminalRunReport({
          datasetRef: TERMINAL_BENCH_DATASET_REF,
          timestamp: "2026-08-22T01:00:00.000Z",
          arm: "levers",
          k: 1,
          harborJobIds: ["job-1"],
          sourcePaths: ["/jobs"],
          model: "gpt-5.5",
          preset: "TB +levers",
          trials: [TB_TRIALS[0] as TerminalTrialRecord, tbTrial(1, "graded_pass", 1)],
          defects: [],
        }),
      ),
    })
    expect(projectReport(morePasses).headline).toEqual({ resolved: 2, total: 2 })
  })

  test("versionless TB2.0 artifacts are QUARANTINED, not silently re-scored", () => {
    // The pre-2.1 encoding folded a task's trials into ONE any-pass row; its
    // trial ids, rewards and task versions were never recorded, so there is no
    // honest 2.1 reading of it. It must not enter the new report set.
    expect(() => projectReport(tbLegacyRaw())).toThrow(CanonicalReportIdentityError)
    // …and neither may a report that claims the suite but omits the schema version.
    const { schemaVersion: _dropped, ...versionless } = tbCanonicalRaw()
    expect(() => projectReport(versionless)).toThrow(/schemaVersion/)
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
    // These all keep the identity fields intact, so only a real validating decode
    // can refuse them. The Terminal projector re-checks nothing itself.
    refuses(tbCanonicalRaw(undefined, { trials: "task-a,task-b" }))
    refuses(tbCanonicalRaw(undefined, { trials: [{ trialId: "t" }] }))
    refuses(tbCanonicalRaw(undefined, { admission: undefined }))
    refuses(tbCanonicalRaw(undefined, { outcomes: undefined }))
    refuses(tbCanonicalRaw(undefined, { preset: 7 }))
    refuses(tbCanonicalRaw(undefined, { k: "five" }))
    // A receipt whose OUTCOME is outside the closed eight-class taxonomy.
    refuses(
      tbCanonicalRaw(undefined, {
        trials: [{ ...TB_TRIALS[0], outcome: "flaky" }],
        outcomes: { ...(tbCanonicalRaw().outcomes as Record<string, number>) },
      }),
    )
    // A tally that disagrees with the receipts it claims to summarise.
    refuses(
      tbCanonicalRaw(undefined, {
        outcomes: {
          ...(tbCanonicalRaw().outcomes as Record<string, number>),
          graded_pass: 99,
        },
      }),
    )
    // NON-VACUITY: the untouched fixture still projects.
    expect(projectReport(tbCanonicalRaw()).viewId).toBe("terminal-bench")
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
      "Terminal-Bench 2.1",
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
    expect(keyOf("nightly", tb.campaignIdentity)).toContain(
      `[terminal-bench@2.1 ${TERMINAL_BENCH_DATASET_REF} `,
    )
    expect(keyOf("nightly", tb.campaignIdentity).endsWith("] nightly")).toBe(true)
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
