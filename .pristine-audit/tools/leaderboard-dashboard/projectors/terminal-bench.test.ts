/**
 * TB21-05 — the Terminal-Bench 2.1 suite projector.
 *
 * The fixtures are REAL artifacts: built by TB21-04's production builder
 * (`buildTerminalRunReport`) and TB21-03's production manifest builder, then
 * encoded exactly as `writeReport` lands them on disk and read back through the
 * one canonical decode. Nothing here hand-writes a report shape.
 *
 * What this pins:
 *  - a run's per-trial channel reaches the dashboard LOSSLESSLY (one row per
 *    trial, never a per-task any-pass fold);
 *  - a crash trial STAYS in the official-shaped denominator (TB21-04 reversed
 *    the old D1 exclusion, and the dashboard must agree with the scorer);
 *  - the campaign key carries the FULL run identity, so two profiles / two
 *    dataset refs / two efforts never coalesce into one score;
 *  - a report with missing identity, a versionless one, and one that claims
 *    `datasetFamily:"terminal-bench"` are all QUARANTINED with a visible reason.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
import { clearQuarantine, projectReport, quarantinedArtifacts, recordQuarantine } from "./registry"
import { type TerminalTrialRow, terminalBenchProjector } from "./terminal-bench"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const trial = (
  index: number,
  outcome: TerminalTrialOutcome,
  reward: number | null,
  over: Partial<TerminalTrialRecord> = {},
): TerminalTrialRecord => {
  const taskId = CANONICAL_TASK_IDS[index] as string
  return {
    trialId: `trial-${index}-${outcome}`,
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
    sourcePath: `/jobs/${index}/result.json`,
    harborJobId: "job-1",
    trajectoryPath: `/jobs/${index}/trajectory.json`,
    ...over,
  }
}

/** The full TB21-03 manifest a real run always carries. */
const manifest = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: "terminal-bench-run/v2",
  benchmarkSuite: "terminal-bench",
  benchmarkVersion: "2.1",
  dataset: TERMINAL_BENCH_DATASET,
  datasetRef: TERMINAL_BENCH_DATASET_REF,
  harborVersion: "0.21.0",
  quantaSha: "8cdf4badbe83",
  dirty: false,
  agentVersion: "1.0.025+g8cdf4badbe83",
  profile: "quanta-full",
  model: "gpt-5.5",
  provider: "openai",
  reasoningEffort: "xhigh",
  sandbox: "docker",
  k: 2,
  concurrency: 4,
  timestamp: "2026-08-22T01:00:00.000Z",
  arm: "quanta-full",
  preset: "terminal-bench-2.1/quanta-full",
  promotable: false,
  taskSelection: "full",
  ...over,
})

interface ReportOpts {
  readonly trials?: readonly TerminalTrialRecord[]
  readonly k?: number
  readonly manifest?: Record<string, unknown> | null
  readonly overrides?: Record<string, unknown>
}

/** A persisted Terminal artifact, exactly as it lands on disk. */
const artifact = (opts: ReportOpts = {}): Record<string, unknown> => {
  const built = buildTerminalRunReport({
    datasetRef: TERMINAL_BENCH_DATASET_REF,
    timestamp: "2026-08-22T01:00:00.000Z",
    arm: (opts.manifest?.arm as string) ?? "quanta-full",
    k: opts.k ?? 2,
    harborJobIds: ["job-1"],
    sourcePaths: ["/jobs"],
    model: "gpt-5.5",
    preset: (opts.manifest?.preset as string) ?? "terminal-bench-2.1/quanta-full",
    trials: opts.trials ?? [trial(0, "graded_pass", 1), trial(1, "graded_fail", 0)],
    defects: [],
  })
  const encoded = encodeCanonicalReport(built)
  const withManifest =
    opts.manifest === null ? encoded : { ...encoded, manifest: opts.manifest ?? manifest() }
  return JSON.parse(JSON.stringify({ ...withManifest, ...opts.overrides })) as Record<
    string,
    unknown
  >
}

const project = (opts: ReportOpts = {}) => {
  const projected = projectReport(artifact(opts))
  // The Terminal projector's rows ARE trial receipts; the shared contract only
  // promises `{id, passed}`, so narrow once here rather than at every read.
  return { ...projected, rows: projected.rows as readonly TerminalTrialRow[] | undefined }
}

// ---------------------------------------------------------------------------
// Lossless per-trial rows
// ---------------------------------------------------------------------------

describe("TB21-05 projector — the per-trial channel reaches the dashboard losslessly", () => {
  test("one row per TRIAL, never a per-task fold", () => {
    const taskId = CANONICAL_TASK_IDS[0] as string
    // Same task, two trials: a pass and a fail. A per-task any-pass fold would
    // emit ONE row; the receipt channel emits two.
    const p = project({
      trials: [
        trial(0, "graded_pass", 1),
        { ...trial(0, "graded_fail", 0), trialId: "trial-0-second" },
      ],
    })
    const rows = p.rows ?? []
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.taskId)).toEqual([taskId, taskId])
    expect(rows.map((r) => r.passed)).toEqual([true, false])
    expect(new Set(rows.map((r) => r.id)).size).toBe(2)
  })

  test("each row carries the receipt fields the per-task matrix renders", () => {
    const row = (project().rows ?? [])[0]
    expect(row).toMatchObject({
      passed: true,
      outcome: "graded_pass",
      reward: 1,
      costUsd: 0.5,
      durationMs: 300_000,
      harborJobId: "job-1",
      trajectoryPath: "/jobs/0/trajectory.json",
    })
    expect(row?.taskName).toBe((CANONICAL_TASK_IDS[0] as string).split("/")[1])
  })

  test("a CRASH trial stays a row and stays in the denominator (TB21-04 reversed D1)", () => {
    const p = project({
      trials: [
        trial(0, "graded_pass", 1),
        trial(1, "graded_fail", 0),
        trial(2, "agent_crash", null),
        trial(3, "agent_timeout", null),
      ],
    })
    expect(p.rows).toHaveLength(4)
    // The persisted headline counts every trial: 1 of 4, not 1 of 2 or 1 of 3.
    expect(p.headline).toEqual({ resolved: 1, total: 4 })
    // ...and the crash row carries NO re-runnable-hole channel, so the shell's
    // shared denominator cannot silently drop it either.
    const crash = (p.rows ?? []).find((r) => r.outcome === "agent_crash")
    expect(crash).toBeDefined()
    expect("error" in (crash ?? {})).toBe(false)
    expect("fail" in (crash ?? {})).toBe(false)
    expect(crash?.passed).toBe(false)
  })

  test("PAIRED CONTROL: the headline follows the persisted tally, not the rows", () => {
    expect(project().headline).toEqual({ resolved: 1, total: 2 })
    expect(
      project({ trials: [trial(0, "graded_pass", 1), trial(1, "graded_pass", 1)] }).headline,
    ).toEqual({ resolved: 2, total: 2 })
  })
})

// ---------------------------------------------------------------------------
// The run payload: provenance + persisted metrics, never recomputed
// ---------------------------------------------------------------------------

describe("TB21-05 projector — the run payload carries exact provenance", () => {
  test("dataset ref, harbor version, quanta sha/dirty, agent version, provider/model, effort, profile, sandbox", () => {
    const view = project().runPayload
    expect(view).toMatchObject({
      benchmarkVersion: "2.1",
      dataset: TERMINAL_BENCH_DATASET,
      datasetRef: TERMINAL_BENCH_DATASET_REF,
      harborVersion: "0.21.0",
      quantaSha: "8cdf4badbe83",
      dirty: false,
      agentVersion: "1.0.025+g8cdf4badbe83",
      provider: "openai",
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      profile: "quanta-full",
      sandbox: "docker",
      k: 2,
    })
  })

  test("the PERSISTED official metrics ride along verbatim; nothing is recomputed", () => {
    const view = project().runPayload as { metrics: Record<string, unknown> }
    // 1 pass of 2 trials ⇒ the scorer's own 50.
    expect(view.metrics.accuracy).toBe(50)
    expect(view.metrics.nTrials).toBe(2)
    expect(view.metrics).toHaveProperty("accuracyStderr")
    expect(view.metrics).toHaveProperty("passAtK")
    expect(view.metrics).toHaveProperty("displayTotalCostUsd")
    expect(view.metrics).toHaveProperty("avgTrialDurationSec")
  })

  test("admission (trials present/expected, coverage, status) rides along verbatim", () => {
    const view = project().runPayload as { admission: Record<string, unknown> }
    expect(view.admission).toMatchObject({
      verdict: "incomplete",
      complete: false,
      standardConfig: true,
      k: 2,
      expectedTaskCount: 89,
      observedTaskCount: 2,
      expectedTrials: 178,
      admittedTrials: 2,
    })
    expect(Array.isArray(view.admission.reasons)).toBe(true)
  })

  test("the eight-class outcome tally rides along (graded pass/fail AND error counts)", () => {
    const view = project({
      trials: [
        trial(0, "graded_pass", 1),
        trial(1, "graded_fail", 0),
        trial(2, "agent_crash", null),
        trial(3, "environment_error", null),
      ],
    }).runPayload as { outcomes: Record<string, number> }
    expect(view.outcomes).toMatchObject({
      graded_pass: 1,
      graded_fail: 1,
      agent_crash: 1,
      environment_error: 1,
      agent_timeout: 0,
      verifier_error: 0,
      missing_reward: 0,
      malformed_result: 0,
    })
  })
})

// ---------------------------------------------------------------------------
// Identity: reports of different identity NEVER coalesce
// ---------------------------------------------------------------------------

const keyOf = (label: string, campaignIdentity: string): string =>
  campaignKeyOf({ file: `/runs/${label}.report.json`, label, model: "m", campaignIdentity })

describe("TB21-05 projector — the campaign key carries the FULL run identity", () => {
  test("suite@version + dataset ref + profile + model + effort + sandbox + k + standard-config", () => {
    const id = project().campaignIdentity
    for (const part of [
      "terminal-bench@2.1",
      TERMINAL_BENCH_DATASET_REF,
      "quanta-full",
      "openai/gpt-5.5",
      "xhigh",
      "docker",
      "k=2",
      "std",
    ]) {
      expect(id).toContain(part)
    }
  })

  const identities = (over: Record<string, unknown>): [string, string] => [
    project().campaignIdentity,
    project({ manifest: manifest(over) }).campaignIdentity,
  ]

  test("EVERY identity axis splits the campaign (each one, independently)", () => {
    for (const over of [
      { profile: "control", arm: "control", preset: "terminal-bench-2.1/control" },
      { model: "gpt-5.4" },
      { provider: "anthropic" },
      { reasoningEffort: "high" },
      { sandbox: "daytona" },
    ]) {
      const [a, b] = identities(over)
      expect(a).not.toBe(b)
      expect(keyOf("nightly", a)).not.toBe(keyOf("nightly", b))
    }
  })

  test("two profiles remain TWO scored rows (never a baseline ∪ levers union)", () => {
    const control = project({
      manifest: manifest({
        profile: "control",
        arm: "control",
        preset: "terminal-bench-2.1/control",
      }),
    })
    const full = project()
    expect(control.presetLabel).toBe("terminal-bench-2.1/control")
    expect(full.presetLabel).toBe("terminal-bench-2.1/quanta-full")
    expect(keyOf("tb", control.campaignIdentity)).not.toBe(keyOf("tb", full.campaignIdentity))
  })

  test("a different k is a different campaign", () => {
    expect(project({ k: 2 }).campaignIdentity).not.toBe(
      project({ k: 1, manifest: manifest({ k: 1 }) }).campaignIdentity,
    )
  })

  test("a different pinned dataset ref stays TWO groups, never one", () => {
    const a = project()
    const b = project({
      overrides: { datasetRef: "sha256:deadbeef" },
      manifest: manifest({ datasetRef: "sha256:deadbeef" }),
    })
    expect(a.campaignIdentity).not.toBe(b.campaignIdentity)
    expect(keyOf("tb", a.campaignIdentity)).not.toBe(keyOf("tb", b.campaignIdentity))
  })

  test("a NONSTANDARD-config run never shares a campaign with a standard one", () => {
    const standard = project()
    const tampered = project({
      trials: [
        trial(0, "graded_pass", 1, { configOverrides: ["timeout_multiplier=3"] }),
        trial(1, "graded_fail", 0),
      ],
    })
    expect(standard.campaignIdentity).not.toBe(tampered.campaignIdentity)
  })

  test("Terminal runs still carry NO dataset family axis", () => {
    expect(project().datasetFamily).toBeUndefined()
    expect(project().benchmarkSuite).toBe("terminal-bench")
    expect(project().viewId).toBe("terminal-bench")
    expect(project().instanceRowKind).toBe("trial-receipt")
  })
})

// ---------------------------------------------------------------------------
// Quarantine
// ---------------------------------------------------------------------------

describe("TB21-05 projector — missing / wrong identity is QUARANTINED", () => {
  test("a report with NO run manifest is refused (identity is never invented)", () => {
    expect(() => project({ manifest: null })).toThrow(CanonicalReportIdentityError)
  })

  test("each required manifest identity field, dropped individually, refuses", () => {
    for (const field of ["profile", "provider", "reasoningEffort", "sandbox"]) {
      const partial = manifest()
      delete partial[field]
      expect(() => project({ manifest: partial })).toThrow(new RegExp(field))
    }
    // NON-VACUITY: the untouched manifest still projects.
    expect(project().viewId).toBe("terminal-bench")
  })

  test("a versionless (TB2.0) artifact cannot create a Terminal run at all", () => {
    const { schemaVersion: _dropped, ...versionless } = artifact()
    expect(() => projectReport(versionless)).toThrow(/schemaVersion/)
  })

  test("a report marked datasetFamily:'terminal-bench' is refused as invalid", () => {
    expect(() =>
      projectReport(artifact({ overrides: { datasetFamily: "terminal-bench" } })),
    ).toThrow(CanonicalReportIdentityError)
  })

  test("a refused artifact with TERMINAL identity is claimed for a VISIBLE diagnostic", () => {
    clearQuarantine()
    const { schemaVersion: _dropped, ...versionless } = artifact()
    let refused: unknown
    try {
      projectReport(versionless)
    } catch (error) {
      refused = error
    }
    expect(refused).toBeInstanceOf(CanonicalReportIdentityError)
    recordQuarantine("/runs/old-tb.report.json", versionless, refused)
    const listed = quarantinedArtifacts()
    expect(listed).toHaveLength(1)
    expect(listed[0]?.file).toBe("/runs/old-tb.report.json")
    expect(listed[0]?.suite).toBe("terminal-bench")
    expect(listed[0]?.reason).toMatch(/schemaVersion/)
    clearQuarantine()
  })

  test("the pre-BFND-02 TB2.0 encoding is claimed by its own provenance marker", () => {
    clearQuarantine()
    // The versionless TB2.0 writer stamped `source: "terminal-bench-harbor"`.
    // Claiming on THAT is provenance, not the dataset-family axis (which stays
    // dead: nothing here reads `datasetFamily` as a suite id).
    recordQuarantine(
      "/runs/tb20.report.json",
      { source: "terminal-bench-harbor", perInstance: [] },
      new CanonicalReportIdentityError('must not carry the terminal-only "trials"'),
    )
    expect(quarantinedArtifacts()[0]?.suite).toBe("terminal-bench")
    clearQuarantine()
  })

  test("a refused SWE artifact is NOT claimed by the Terminal suite", () => {
    clearQuarantine()
    recordQuarantine(
      "/runs/swe.report.json",
      { datasetFamily: "nope", perInstance: [] },
      new CanonicalReportIdentityError("unknown datasetFamily"),
    )
    expect(quarantinedArtifacts()[0]?.suite).toBeUndefined()
    clearQuarantine()
  })
})

// ---------------------------------------------------------------------------
// Views + suite data
// ---------------------------------------------------------------------------

describe("TB21-05 projector — the view label and the suite payload", () => {
  test("the suite is labelled Terminal-Bench 2.1", () => {
    const views = terminalBenchProjector.viewsFor(new Set(["terminal-bench"]))
    expect(views).toEqual([
      { id: "terminal-bench", label: "Terminal-Bench 2.1", suite: "terminal-bench" },
    ])
    // ...and it grants no tab when no Terminal run is present.
    expect(terminalBenchProjector.viewsFor(new Set())).toEqual([])
  })

  test("DATA.tb is a VERSIONED 2.1 payload built from the checked-in importer output", () => {
    const rawdataDir = join(import.meta.dir, "..", "rawdata")
    const data = terminalBenchProjector.data?.({ rawdataDir, argOf: () => undefined }) as {
      tb: {
        schemaVersion: string
        official: { upstreamRef: string; submissions: unknown[] } | null
      }
    }
    expect(data.tb.schemaVersion).toBe("terminal-bench-dashboard/v2")
    expect(data.tb.official?.upstreamRef).toBe("7131e4375048a0e408a8fb404b5f499d726b695b")
    expect(data.tb.official?.submissions).toHaveLength(1)
    // The 2.0 markdown channel is GONE — no scaffolds/tasks matrix survives.
    expect(data.tb).not.toHaveProperty("tasks")
    expect(data.tb).not.toHaveProperty("scaffolds")
  })

  test("an absent / malformed official payload degrades to null (renders —), never crashes", () => {
    const dir = mkdtempSync(join(tmpdir(), "tb21-05-"))
    try {
      const absent = terminalBenchProjector.data?.({ rawdataDir: dir, argOf: () => undefined }) as {
        tb: { official: unknown }
      }
      expect(absent.tb.official).toBeNull()
      writeFileSync(join(dir, "terminal-bench-official.json"), "{ not json")
      const malformed = terminalBenchProjector.data?.({
        rawdataDir: dir,
        argOf: () => undefined,
      }) as { tb: { official: unknown } }
      expect(malformed.tb.official).toBeNull()
      // ...and a payload pinned to a MUTABLE ref is refused rather than shown.
      writeFileSync(
        join(dir, "terminal-bench-official.json"),
        JSON.stringify({
          schemaVersion: "terminal-bench-official/v1",
          upstreamRef: "main",
          submissions: [],
        }),
      )
      const mutable = terminalBenchProjector.data?.({
        rawdataDir: dir,
        argOf: () => undefined,
      }) as {
        tb: { official: unknown }
      }
      expect(mutable.tb.official).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
