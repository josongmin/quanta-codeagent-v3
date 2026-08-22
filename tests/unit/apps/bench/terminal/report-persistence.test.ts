/**
 * TB21-04 × BFND-02 — the Terminal branch of the canonical envelope, and the
 * LAST hop of the pipeline (RED-first hellgate).
 *
 * The blocking conflict this closes: BFND-02's landed `TerminalBenchReport` was
 * LOSSY against TB21-04's receipt — no reward, no task id/ref, no tokens, no
 * cost, no trajectory path, and a two-value `error.kind` where the taxonomy has
 * eight classes. So a run could be scored losslessly in memory and then be
 * flattened the moment it was persisted, which is the same defect
 * `tb-report-emit.ts` had one layer down.
 *
 * Every rail here observes a REAL effect: bytes produced by the real builder,
 * bytes actually written by the canonical writer, a real decode of those bytes
 * back off disk, and the real `terminal report` command driven end to end. The
 * one source-scan rail (single-writer ownership) carries a known-caller floor
 * and non-vacuity probes, per the ticket.
 *
 * SPEND: nothing here can provision or bill. Only the `report` action is driven,
 * and its deps are injected; no `spawnHarbor` port is ever supplied.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { cmdTerminal } from "../../../../../src/apps/bench/commands/terminal"
import { resolveTerminalRunConfig } from "../../../../../src/apps/bench/terminal/config"
import {
  CANONICAL_TASK_IDS,
  canonicalTaskRef,
  EXPECTED_TASK_COUNT,
  MIN_TRIALS_PER_TASK,
  TERMINAL_BENCH_DATASET,
  TERMINAL_BENCH_DATASET_REF,
} from "../../../../../src/apps/bench/terminal/dataset"
import { scanHarborJobDir } from "../../../../../src/apps/bench/terminal/harbor-results"
import { buildTerminalRunManifest } from "../../../../../src/apps/bench/terminal/manifest"
import {
  buildTerminalRunReport,
  isTrialDefect,
  parseHarborTrialResult,
  type TerminalRunInput,
  type TerminalRunReport,
  type TerminalTrialRecord,
} from "../../../../../src/apps/bench/terminal/report"
import {
  type CanonicalBenchReport,
  decodeCanonicalReport,
  encodeCanonicalReport,
  writeReport,
} from "../../../../../src/runner/batch/report"
import { __resetRuntimeConfig } from "../../../../../src/shared/runtime-config"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")
const read = (path: string): string => readFileSync(join(REPO_ROOT, path), "utf8")

const FIXTURES = join(import.meta.dir, "fixtures")
const CANARY = join(FIXTURES, "harbor-jobs", "canary-k5")
const TB20 = join(FIXTURES, "harbor-jobs", "tb20-legacy")

const RUN_META: Omit<TerminalRunInput, "trials" | "defects"> = {
  datasetRef: TERMINAL_BENCH_DATASET_REF,
  timestamp: "2026-08-22T00:00:00.000Z",
  arm: "baseline",
  k: MIN_TRIALS_PER_TASK,
  harborJobIds: ["622b427f-0ddc-54db-b64b-90960667e6be"],
  sourcePaths: [CANARY],
  model: "openai/gpt-5.6-luna",
  preset: "tb21-canary",
}

/** The REAL pipeline, filesystem included: scan → parse → partition. */
const trialsFrom = (jobDir: string): TerminalTrialRecord[] => {
  const parsed = scanHarborJobDir(jobDir).map(parseHarborTrialResult)
  return parsed.flatMap((p) => (isTrialDefect(p) ? [] : [p]))
}

const buildFrom = (
  trials: readonly TerminalTrialRecord[],
  overrides: Partial<TerminalRunInput> = {},
): TerminalRunReport => buildTerminalRunReport({ ...RUN_META, trials, defects: [], ...overrides })

/** Write through the ONE canonical writer, then read the bytes back off disk and
 *  decode them at the ONE read boundary. Nothing is asserted from memory. */
const roundTrip = async (
  report: CanonicalBenchReport,
  fn: (decoded: CanonicalBenchReport, bytes: string, mirrorDir: string) => void,
): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), "tb21-persist-"))
  const prior = process.env.QUANTA_BENCH_RESULTS_DIR
  process.env.QUANTA_BENCH_RESULTS_DIR = join(dir, "ssot-mirror")
  __resetRuntimeConfig()
  try {
    const file = join(dir, "run", "terminal.report.json")
    await writeReport(file, report)
    const bytes = readFileSync(file, "utf8")
    fn(decodeCanonicalReport(JSON.parse(bytes)), bytes, join(dir, "ssot-mirror"))
  } finally {
    if (prior === undefined) delete process.env.QUANTA_BENCH_RESULTS_DIR
    else process.env.QUANTA_BENCH_RESULTS_DIR = prior
    __resetRuntimeConfig()
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Narrow the decoded union to the Terminal branch, loudly. */
const asTerminal = (decoded: CanonicalBenchReport): TerminalRunReport => {
  if (decoded.benchmarkSuite !== "terminal-bench") {
    throw new Error(`expected the terminal branch, got ${decoded.benchmarkSuite}`)
  }
  return decoded as TerminalRunReport
}

// ─────────────────── 1. lossless per-trial receipts through disk ─────────────

describe("TB21-04 receipts survive the canonical writer intact", () => {
  test("every field the taxonomy needs round-trips: reward, task ref, tokens, cost, trajectory", async () => {
    const trials = trialsFrom(CANARY)
    expect(trials.length).toBe(15)
    const report = buildFrom(trials)
    await roundTrip(report, (decoded) => {
      const back = asTerminal(decoded)
      // The whole receipt set, verbatim — not a headline, not a fold.
      expect(back.trials).toEqual(report.trials)
      expect(back.trials.length).toBe(15)
      // …and each individually-lossy field is named, so a partial rebuild that
      // dropped one of them cannot hide behind the deep-equal above.
      const withCost = back.trials.filter((t) => t.costUsd !== null)
      expect(withCost.length).toBeGreaterThan(0)
      const withTokens = back.trials.filter((t) => t.outputTokens !== null)
      expect(withTokens.length).toBeGreaterThan(0)
      const withTrajectory = back.trials.filter((t) => t.trajectoryPath !== undefined)
      expect(withTrajectory.length).toBeGreaterThan(0)
      for (const trial of back.trials) {
        expect(typeof trial.trialId).toBe("string")
        expect(trial.taskRef).toBe(canonicalTaskRef(trial.taskId))
        expect(trial.reward === null || typeof trial.reward === "number").toBe(true)
      }
      // The precomputed official metrics and the admission verdict persist too.
      expect(back.metrics).toEqual(report.metrics)
      expect(back.admission).toEqual(report.admission)
      expect(back.outcomes).toEqual(report.outcomes)
      expect(back.manifest).toBeUndefined()
    })
  })

  test("the persisted bytes carry the v2 identity and NO SWE family axis", async () => {
    await roundTrip(buildFrom(trialsFrom(CANARY)), (_decoded, bytes) => {
      const raw = JSON.parse(bytes) as Record<string, unknown>
      expect(raw.schemaVersion).toBe("terminal-bench-report/v2")
      expect(raw.benchmarkSuite).toBe("terminal-bench")
      expect(raw.benchmarkVersion).toBe("2.1")
      expect(raw.dataset).toBe(TERMINAL_BENCH_DATASET)
      expect(raw.datasetRef).toBe(TERMINAL_BENCH_DATASET_REF)
      expect("datasetFamily" in raw).toBe(false)
      // The lossless channel is `trials`, never a folded `perInstance`.
      expect(Array.isArray(raw.trials)).toBe(true)
    })
  })

  test("two trials of ONE task — one pass, one fail — stay TWO receipts through persistence", async () => {
    const all = trialsFrom(CANARY)
    const taskId = all[0]?.taskId as string
    const sameTask = all.filter((t) => t.taskId === taskId)
    const pass = sameTask.find((t) => t.outcome === "graded_pass")
    const fail = sameTask.find((t) => t.outcome === "graded_fail")
    // Non-vacuity: the fixture really does contain both outcomes for one task.
    expect(pass).toBeDefined()
    expect(fail).toBeDefined()
    const pair = [pass as TerminalTrialRecord, fail as TerminalTrialRecord]
    await roundTrip(buildFrom(pair, { k: 2 }), (decoded) => {
      const back = asTerminal(decoded)
      expect(back.trials.length).toBe(2)
      expect(back.trials.map((t) => t.trialId).sort()).toEqual(pair.map((t) => t.trialId).sort())
      expect(new Set(back.trials.map((t) => t.taskId))).toEqual(new Set([taskId]))
      expect(back.outcomes.graded_pass).toBe(1)
      expect(back.outcomes.graded_fail).toBe(1)
    })
  })

  test("an ERROR trial lowers official-shaped accuracy through persistence (paired control)", async () => {
    const all = trialsFrom(CANARY)
    const graded = all.filter((t) => t.outcome === "graded_pass" || t.outcome === "graded_fail")
    const passes = graded.filter((t) => t.outcome === "graded_pass").slice(0, 2)
    expect(passes.length).toBe(2)
    // A REAL infra fault: reward absent, exception recorded. Built from a real
    // record so nothing about its shape is invented.
    const crashed: TerminalTrialRecord = {
      ...(passes[1] as TerminalTrialRecord),
      trialId: `${passes[1]?.trialId}-crash`,
      reward: null,
      outcome: "agent_crash",
      exceptionType: "RuntimeError",
    }
    const withCrash = buildFrom([passes[0] as TerminalTrialRecord, crashed], { k: 2 })
    const withoutCrash = buildFrom([passes[0] as TerminalTrialRecord], { k: 1 })
    await roundTrip(withCrash, (decoded) => {
      const back = asTerminal(decoded)
      // 2 trials, 1 success ⇒ 50%. The crash is a ZERO, never a hole.
      expect(back.metrics?.nTrials).toBe(2)
      expect(back.metrics?.accuracy).toBe(50)
      expect(back.outcomes.agent_crash).toBe(1)
    })
    await roundTrip(withoutCrash, (decoded) => {
      // Paired control: remove the crash from the INPUT and accuracy moves,
      // proving the crashed row was genuinely in the denominator.
      expect(asTerminal(decoded).metrics?.accuracy).toBe(100)
    })
  })
})

// ─────────────────── 2. admission survives, and fails closed ─────────────────

describe("admission verdicts are persisted, not recomputed by a reader", () => {
  test("duplicate trial ids FAIL — the run is rejected and carries no metric", async () => {
    const one = trialsFrom(CANARY)[0] as TerminalTrialRecord
    const report = buildFrom([one, { ...one }], { k: 2 })
    expect(report.admission.verdict).toBe("rejected")
    expect(report.metrics).toBeUndefined()
    await roundTrip(report, (decoded) => {
      const back = asTerminal(decoded)
      expect(back.admission.verdict).toBe("rejected")
      expect(back.admission.duplicateTrialIds).toEqual([one.trialId])
      expect(back.metrics).toBeUndefined()
      // Both rows survive: a rejected run is still losslessly readable.
      expect(back.trials.length).toBe(2)
    })
  })

  test("a persisted report whose admission DISAGREES with its trials is refused at the read boundary", () => {
    const one = trialsFrom(CANARY)[0] as TerminalTrialRecord
    const honest = buildFrom([one, { ...one }], { k: 2 })
    const raw = JSON.parse(JSON.stringify(encodeCanonicalReport(honest))) as Record<string, unknown>
    // Hand-edit the verdict to launder a duplicate-id run into an official one.
    const admission = { ...(raw.admission as Record<string, unknown>) }
    admission.verdict = "official"
    admission.duplicateTrialIds = []
    expect(() => decodeCanonicalReport({ ...raw, admission })).toThrow(/duplicate/i)
  })

  test("a persisted outcome tally that disagrees with the trials is refused", () => {
    const report = buildFrom(trialsFrom(CANARY))
    const raw = JSON.parse(JSON.stringify(encodeCanonicalReport(report))) as Record<string, unknown>
    const outcomes = { ...(raw.outcomes as Record<string, number>) }
    outcomes.graded_pass = (outcomes.graded_pass ?? 0) + 3
    expect(() => decodeCanonicalReport({ ...raw, outcomes })).toThrow(/outcomes/)
  })

  test("wrong dataset ref FAILS at build; a MISSING one fails at the read boundary too", () => {
    const trials = trialsFrom(CANARY)
    // The PIN lives with the builder — only TB21-04 knows which revision of the
    // 89-task dataset is canonical today.
    expect(() => buildFrom(trials, { datasetRef: "sha256:deadbeef" })).toThrow(/datasetRef/)
    expect(() => buildFrom(trials, { datasetRef: "latest" })).toThrow(/datasetRef/)
    // The READ boundary deliberately requires only a non-empty ref: it must stay
    // able to read reports written against an EARLIER pin (that is what makes the
    // ref a campaign key rather than a version gate). What it refuses is an
    // artifact that cannot say which dataset produced its rewards at all.
    const raw = JSON.parse(JSON.stringify(encodeCanonicalReport(buildFrom(trials)))) as Record<
      string,
      unknown
    >
    const { datasetRef: _dropped, ...withoutRef } = raw
    expect(() => decodeCanonicalReport(withoutRef)).toThrow(/datasetRef/)
    expect(() => decodeCanonicalReport({ ...raw, datasetRef: "   " })).toThrow(/datasetRef/)
    expect(() => decodeCanonicalReport({ ...raw, datasetRef: 7 })).toThrow(/datasetRef/)
    // NON-VACUITY: an older-but-well-formed pin still reads.
    expect(
      (decodeCanonicalReport({ ...raw, datasetRef: "sha256:older" }) as { datasetRef: string })
        .datasetRef,
    ).toBe("sha256:older")
  })

  test("a MISSING reward makes the run incomplete — never a fabricated miss", async () => {
    const trials = trialsFrom(CANARY)
    // The real canary tree already contains one reward-less trial; strip one MORE
    // so the assertion below is a DELTA, not a coincidence of the fixture.
    const baseline = buildFrom(trials).outcomes.missing_reward
    expect(baseline).toBeGreaterThan(0)
    const stripped = trials.map((t, i) =>
      i === 0 ? ({ ...t, reward: null, outcome: "missing_reward" } as TerminalTrialRecord) : t,
    )
    expect(trials[0]?.reward).not.toBeNull()
    const report = buildFrom(stripped)
    await roundTrip(report, (decoded) => {
      const back = asTerminal(decoded)
      expect(back.admission.complete).toBe(false)
      expect(back.admission.reasons.some((r) => r.startsWith("missing-reward:"))).toBe(true)
      expect(back.outcomes.missing_reward).toBe(baseline + 1)
      // The row is STILL there with a null reward — no invented 0, no invented pass.
      expect(back.trials[0]?.reward).toBeNull()
      expect(back.trials.length).toBe(trials.length)
      // …and the reward-less rows are still in the metric denominator.
      expect(back.metrics?.nTrials).toBe(trials.length)
    })
  })

  test("a 444-trial k=5 report does NOT render as complete after persistence", async () => {
    const template = trialsFrom(CANARY).find((t) => t.outcome === "graded_pass")
    expect(template).toBeDefined()
    const full: TerminalTrialRecord[] = []
    for (const taskId of CANONICAL_TASK_IDS) {
      for (let i = 0; i < MIN_TRIALS_PER_TASK; i += 1) {
        full.push({
          ...(template as TerminalTrialRecord),
          trialId: `${taskId}#${i}`,
          taskId,
          taskName: taskId.split("/")[1] as string,
          taskRef: canonicalTaskRef(taskId) as string,
        })
      }
    }
    expect(full.length).toBe(EXPECTED_TASK_COUNT * MIN_TRIALS_PER_TASK)
    // The COMPLETE control first — otherwise "incomplete" below proves nothing.
    await roundTrip(buildFrom(full), (decoded) => {
      const back = asTerminal(decoded)
      expect(back.admission.complete).toBe(true)
      expect(back.admission.verdict).toBe("official")
      expect(back.admission.admittedTrials).toBe(445)
    })
    await roundTrip(buildFrom(full.slice(0, 444)), (decoded) => {
      const back = asTerminal(decoded)
      expect(back.admission.complete).toBe(false)
      expect(back.admission.verdict).toBe("incomplete")
      expect(back.admission.admittedTrials).toBe(444)
      expect(back.admission.expectedTrials).toBe(445)
    })
  })

  test("versionless TB2.0 artifacts are QUARANTINED: rejected by admission and by the reader", async () => {
    // (a) a real TB2.0 trial tree carries no canonical task ref ⇒ rejected.
    const legacy = trialsFrom(TB20)
    expect(legacy.length).toBeGreaterThan(0)
    const report = buildFrom(legacy, { k: 1 })
    expect(report.admission.verdict).toBe("rejected")
    expect(report.metrics).toBeUndefined()
    await roundTrip(report, (decoded) => {
      expect(asTerminal(decoded).admission.verdict).toBe("rejected")
    })
    // (b) a versionless PERSISTED terminal artifact (the pre-2.1 encoding) can
    //     never enter the new report set.
    expect(() =>
      decodeCanonicalReport({
        benchmarkSuite: "terminal-bench",
        benchmarkVersion: "2.1",
        datasetRef: TERMINAL_BENCH_DATASET_REF,
        timestamp: "T",
        model: "m",
        source: "terminal-bench-harbor",
        knobs: { preset: "TB +levers", resolved: {}, inactive: [] },
        totals: { total: 4, resolved: 1, resolvedPct: 25 },
        perInstance: [{ id: "kv-store-grpc", passed: true, turns: 0, durationMs: 5 }],
      }),
    ).toThrow(/schemaVersion/)
  })
})

// ─────────────────── 3. the last hop: the command calls the writer ───────────

describe("`terminal report` persists through the CANONICAL writer", () => {
  const runReport = async (
    out: string,
    jobDir: string,
    manifestPath: string,
  ): Promise<{ code: number; output: string }> => {
    const lines: string[] = []
    let code = -1
    await cmdTerminal({
      argv: [
        "bun",
        "cli.ts",
        "terminal",
        "report",
        "--manifest",
        manifestPath,
        "--job-dir",
        jobDir,
        "--out",
        out,
      ],
      env: {},
      write: (t) => lines.push(t),
      exit: (c) => {
        code = c
      },
      // SPEND GUARD: the paid port is supplied as a throwing fake, so a report
      // path that ever reached harbor would fail here instead of billing.
      spawnHarbor: () => {
        throw new Error("terminal report must never spawn harbor")
      },
    })
    return { code, output: lines.join("\n") }
  }

  const writeManifest = (dir: string, jobDir: string): string => {
    const cfg = resolveTerminalRunConfig({
      argv: [
        "bun",
        "cli.ts",
        "terminal",
        "run",
        "--profile",
        "control",
        "--model",
        "gpt-5.5",
        "--provider",
        "openai",
        "--effort",
        "xhigh",
      ],
      env: {},
    })
    const manifest = buildTerminalRunManifest({
      cfg,
      provenance: { packageVersion: "1.0.025", sha: "9d5369d310bb", dirty: false },
      harborVersion: "0.21.0",
      timestamp: "2026-08-22T00:00:00.000Z",
      harborJobIds: ["622b427f-0ddc-54db-b64b-90960667e6be"],
      sourcePaths: [jobDir],
    })
    const path = join(dir, "run-manifest.json")
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
    return path
  }

  test("it writes the canonical artifact AND the canonical mirror — one writer, no second sink", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tb21-cmd-"))
    const mirror = join(dir, "ssot")
    const prior = process.env.QUANTA_BENCH_RESULTS_DIR
    process.env.QUANTA_BENCH_RESULTS_DIR = mirror
    __resetRuntimeConfig()
    try {
      const out = join(dir, "out", "tb21.report.json")
      const { code } = await runReport(out, CANARY, writeManifest(dir, CANARY))
      expect(code).toBe(0)
      // The primary artifact exists and decodes at the ONE read boundary…
      const decoded = asTerminal(decodeCanonicalReport(JSON.parse(readFileSync(out, "utf8"))))
      expect(decoded.trials.length).toBe(15)
      expect(decoded.manifest?.agentVersion).toBe("1.0.025+g9d5369d310bb")
      expect(decoded.arm).toBe("control")
      // …and the canonical SSOT mirror carries the SAME bytes.
      const mirrored = readdirSync(mirror)
      expect(mirrored).toHaveLength(1)
      expect(readFileSync(join(mirror, mirrored[0] as string), "utf8")).toBe(
        readFileSync(out, "utf8"),
      )
    } finally {
      if (prior === undefined) delete process.env.QUANTA_BENCH_RESULTS_DIR
      else process.env.QUANTA_BENCH_RESULTS_DIR = prior
      __resetRuntimeConfig()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("the manifest is carried onto the artifact verbatim (the TB21-03 hand-off)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tb21-cmd-manifest-"))
    const prior = process.env.QUANTA_BENCH_RESULTS_DIR
    process.env.QUANTA_BENCH_RESULTS_DIR = join(dir, "ssot")
    __resetRuntimeConfig()
    try {
      const manifestPath = writeManifest(dir, CANARY)
      const out = join(dir, "tb21.report.json")
      expect((await runReport(out, CANARY, manifestPath)).code).toBe(0)
      const written = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>
      const persisted = JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown>
      expect(persisted.manifest).toEqual(written)
      // …and it survives the READ boundary too. The decode validates the
      // provenance core it depends on and carries the REST verbatim; a rebuild
      // that kept only the validated core would silently drop the knob table,
      // the effort decision and the upload posture — the fields an operator
      // reconciles a leaderboard row against.
      const decoded = asTerminal(decodeCanonicalReport(persisted))
      const manifest = decoded.manifest as unknown as Record<string, unknown>
      expect(manifest).toEqual(written)
      expect(Object.keys(manifest).sort()).toEqual(Object.keys(written).sort())
      // Named, so the deep-equal cannot be the only thing holding this up.
      expect(manifest.resolvedKnobs).toEqual(written.resolvedKnobs)
      expect(manifest.reasoningEffortDecision).toEqual(written.reasoningEffortDecision)
      expect(manifest.upload).toEqual(written.upload)
      expect(manifest.taskSelection).toEqual(written.taskSelection)
    } finally {
      if (prior === undefined) delete process.env.QUANTA_BENCH_RESULTS_DIR
      else process.env.QUANTA_BENCH_RESULTS_DIR = prior
      __resetRuntimeConfig()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("without --out the command refuses rather than inventing a destination", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tb21-cmd-noout-"))
    try {
      const lines: string[] = []
      let code = -1
      await cmdTerminal({
        argv: [
          "bun",
          "cli.ts",
          "terminal",
          "report",
          "--manifest",
          writeManifest(dir, CANARY),
          "--job-dir",
          CANARY,
        ],
        env: {},
        write: (t) => lines.push(t),
        exit: (c) => {
          code = c
        },
      })
      expect(code).toBe(2)
      expect(lines.join("\n")).toContain("--out")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ─────────────────── 4. single-writer ownership (source rail) ────────────────

describe("ONE writer owns Terminal persistence", () => {
  const WRITER_MODULE = "src/runner/batch/report-envelope.ts"
  /** Live-call detector: not an import, not a `.writeReport(` port invocation. */
  const liveWriteReport = /(?<![.\w$])writeReport\s*\(/
  /** Any raw serialization of a report value straight to disk. */
  const rawReportWrite = /(?:writeFileSync|Bun\.write)\s*\([^;]*JSON\.stringify\(\s*report\b/

  /** Every product `.ts` under the given roots (tests excluded). */
  const sourceFiles = (roots: readonly string[]): string[] =>
    roots
      .flatMap((root) =>
        readdirSync(join(REPO_ROOT, root), { recursive: true, withFileTypes: true })
          .filter((e) => e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".test.ts"))
          .map((e) => relative(REPO_ROOT, join(e.parentPath, e.name))),
      )
      .filter((p) => !p.includes("node_modules/"))
      .sort()

  test("detectors are non-vacuous (they fire on the real thing, not on look-alikes)", () => {
    expect(liveWriteReport.test("await writeReport(out, report)")).toBe(true)
    expect(liveWriteReport.test('import { writeReport } from "@/runner/batch/report"')).toBe(false)
    expect(liveWriteReport.test("opts.writeReport(opts.reportOut, report)")).toBe(false)
    expect(rawReportWrite.test("await Bun.write(out, JSON.stringify(report, null, 2))")).toBe(true)
  })

  test("the Terminal report command is a LIVE writeReport( caller (floor asserted)", () => {
    const callers = sourceFiles(["src", "tools"]).filter(
      (f) => f !== WRITER_MODULE && liveWriteReport.test(read(f)),
    )
    // Floor: the SWE batch core and the Terminal report command. A new caller is
    // a deliberate decision, not a silent second persistence path.
    expect(callers).toContain("src/apps/bench/commands/terminal.ts")
    expect(callers).toContain("src/runner/batch/core.ts")
    expect(callers).toEqual(["src/apps/bench/commands/terminal.ts", "src/runner/batch/core.ts"])
  })

  test("no module under the terminal tree serializes a report itself", () => {
    const offenders = sourceFiles(["src/apps/bench/terminal", "src/apps/bench/commands"]).filter(
      (f) => rawReportWrite.test(read(f)),
    )
    expect(offenders).toEqual([])
  })
})
