/**
 * PMX-05 — the report is the SSOT and every surface reads it (RED-first hellgate).
 *
 * `buildReport` persists the official-grade totals + per-instance dispositions
 * ONCE. The CLI summary, the markdown export and the dashboard projector all read
 * that persisted result. Nothing downstream re-folds `perInstance` rows, so a
 * filter or display bug cannot move a headline number.
 *
 * ⚠️ Test isolation: `writeReport` fans out to `mirrorReportToSsot`, whose DEFAULT
 * sink is the operator's LIVE `~/.quanta/bench/results` corpus. Every test here
 * that writes redirects the mirror into a per-test temp dir and resets the
 * memoised runtime config on both edges.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildOfficialGradeReceipt,
  type OfficialGradeDisposition,
  type OfficialGradeEvaluatorMeta,
  type OfficialGradeReason,
  type OfficialGradeState,
} from "@/runner/batch/eval/official-grade"
import {
  type BenchReport,
  buildReport,
  type CanonicalBenchReport,
  DATASET_FAMILIES,
  decodeCanonicalReport,
  encodeCanonicalReport,
  isDatasetFamily,
  type SweBenchReport,
  toCanonicalSweReport,
  writeReport,
} from "@/runner/batch/report"
import {
  type AggregateOfficialGradeInput,
  formatOfficialGradeTotals,
  OfficialGradePartitionError,
  renderOfficialGradeCliLines,
  renderOfficialGradeMarkdown,
} from "@/runner/batch/report-official-grade"
import type { InstanceResult } from "@/runner/batch/types"
import { __resetRuntimeConfig } from "@/shared/runtime-config"
import { campaignKeyOf } from "../../../../tools/leaderboard-dashboard/family-partition"
import { sweBenchProjector } from "../../../../tools/leaderboard-dashboard/projectors/swe-bench"

// ── shared canonical fixture ────────────────────────────────────────────────

const hex = (seed: string): string =>
  Array.from(
    { length: 64 },
    (_, i) => "0123456789abcdef"[(seed.charCodeAt(i % seed.length) + i) % 16],
  ).join("")

const EVALUATOR: OfficialGradeEvaluatorMeta = {
  evaluatorId: "swe-bench-promax",
  upstreamCommit: "77041028bc4e2135644b63b504aa961a68aafbb6",
  evaluatorPath: "/opt/promax/test_run.py",
  evaluatorSha256: hex("evaluator"),
  argv: ["python", "test_run.py"],
  cwd: "/opt/promax",
  exitCode: 0,
  stdout: "SECRET-GRADER-STREAM",
  stderr: "",
  outputArtifact: { path: "/artifacts/pass_rate.json", sha256: hex("out"), byteLength: 4096 },
}

const LANGUAGES = ["C", "C++", "Go", "Java", "Python", "Rust", "TypeScript"] as const

const dispose = (
  id: string,
  state: OfficialGradeState,
  reason: OfficialGradeReason,
): OfficialGradeDisposition => ({
  instanceId: id,
  state,
  reason,
  gradingValid: state === "resolved" || state === "model_miss",
  rawArtifact: { path: `/artifacts/${id}.json`, sha256: hex(id), byteLength: 64 },
  evaluator: {
    passed: state === "resolved",
    model: {
      finalResult: state === "resolved" ? "success" : "apply_failed",
      rawReason: "r",
      returncode: 0,
      scriptExitCode: 0,
    },
    golden: { finalResult: "success", rawReason: "r", returncode: 0, scriptExitCode: 0 },
  },
})

/** 170 assigned · 65 resolved · 103 model_miss · 2 infra_invalid · 0 ambiguous · 0 missing. */
const canonicalInput = (): AggregateOfficialGradeInput => {
  const ids = Array.from({ length: 170 }, (_, i) => `org__repo-${String(i).padStart(4, "0")}`)
  const dispositions: OfficialGradeDisposition[] = ids.map((id, i) =>
    i < 65
      ? dispose(id, "resolved", "official_resolved")
      : i < 168
        ? dispose(id, "model_miss", "test_failed")
        : dispose(id, "infra_invalid", "golden_timeout_eval"),
  )
  const built = buildOfficialGradeReceipt({
    assignedInstanceIds: ids,
    dispositions,
    evaluator: EVALUATOR,
  })
  if (!built.ok) throw new Error(`fixture refused: ${JSON.stringify(built.failures)}`)
  const meta = new Map(
    ids.map((id, i) => [
      id,
      {
        language: LANGUAGES[i % LANGUAGES.length] ?? "unknown",
        predictionSha256: hex(`pred-${id}`),
        image: {
          sourceRef: `ghcr.io/promax/${id}:v1`,
          registryDigest: `sha256:${hex(`img-${id}`)}`,
          localImageId: `sha256:${hex(`local-${id}`)}`,
          platform: "linux/arm64",
        },
      },
    ]),
  )
  return {
    receipt: built.receipt,
    instanceMeta: meta,
    campaign: {
      quantaSha: "9d5369d31",
      quantaDirty: false,
      provider: "openai",
      model: "gpt-5.5",
      reasoningEffort: "high",
      preset: "promax-v1",
      turnBudget: 40,
      tokenWall: 900_000,
      runId: "run-7",
      chunkId: "chunk-2",
      boxId: "i-0abc",
    },
  }
}

const RESULTS: InstanceResult[] = [
  { id: "org__repo-0000", passed: true, patch: "diff", turns: 3 },
  { id: "org__repo-0001", passed: false, patch: "", turns: 4 },
]

const canonicalReport = (): BenchReport =>
  buildReport(
    {
      model: "gpt-5.5",
      provider: "openai",
      n: 170,
      datasetFamily: "promax",
      timestamp: "T",
      officialGrade: canonicalInput(),
    },
    RESULTS,
  )

// ── mirror-safe temp sandbox ────────────────────────────────────────────────

const TMP = mkdtempSync(join(tmpdir(), "pmx05-"))
const PRIOR_RESULTS_DIR = process.env.QUANTA_BENCH_RESULTS_DIR
process.env.QUANTA_BENCH_RESULTS_DIR = join(TMP, "ssot-mirror")
__resetRuntimeConfig()

afterAll(() => {
  if (PRIOR_RESULTS_DIR === undefined) delete process.env.QUANTA_BENCH_RESULTS_DIR
  else process.env.QUANTA_BENCH_RESULTS_DIR = PRIOR_RESULTS_DIR
  __resetRuntimeConfig()
  rmSync(TMP, { recursive: true, force: true })
})

// ── the family axis admits promax, the suite axis never does ────────────────

describe("PMX-05 — promax is a SWE dataset family, never a suite", () => {
  test("the family registry admits promax and keeps it distinct from pro", () => {
    expect(isDatasetFamily("promax")).toBe(true)
    expect(isDatasetFamily("pro")).toBe(true)
    expect([...DATASET_FAMILIES]).toContain("promax")
    // Non-vacuity: it is a CLOSED union, not "anything goes".
    expect(isDatasetFamily("prom")).toBe(false)
    expect(isDatasetFamily("terminal-bench")).toBe(false)
  })

  test('`benchmarkSuite:"promax"` is still REFUSED at the one read boundary', () => {
    expect(() => decodeCanonicalReport({ benchmarkSuite: "promax", totals: {} })).toThrow()
    // ...while the FAMILY form decodes.
    const decoded = decodeCanonicalReport({
      benchmarkSuite: "swe-bench",
      timestamp: "t",
      datasetFamily: "promax",
    })
    expect(decoded.benchmarkSuite).toBe("swe-bench")
    if (decoded.benchmarkSuite === "swe-bench") expect(decoded.datasetFamily).toBe("promax")
  })

  test("pro and promax NEVER group into one campaign", () => {
    const run = (family: string) => ({
      file: "/runs/c/report-x.report.json",
      label: "report-x",
      model: "gpt-5.5",
      campaignIdentity: sweBenchProjector.project({
        benchmarkSuite: "swe-bench",
        datasetFamily: family,
      } as unknown as CanonicalBenchReport).campaignIdentity,
    })
    const pro = campaignKeyOf(run("pro"))
    const promax = campaignKeyOf(run("promax"))
    expect(pro).not.toBe(promax)
    expect(promax).toContain("promax")
    // ProMax and Terminal-Bench never share a campaign key either — different
    // SUITES, so their identity segments cannot collide.
    const terminal = campaignKeyOf({
      file: "/runs/c/report-x.report.json",
      label: "report-x",
      model: "gpt-5.5",
      campaignIdentity: "terminal-bench@2.1 harbor@2.1.0#f00d",
    })
    expect(terminal).not.toBe(promax)
    // ...and neither collides with the bare Verified key (the legacy no-prefix one).
    const verified = campaignKeyOf(run("verified"))
    expect(new Set([pro, promax, verified]).size).toBe(3)
  })

  test("the SWE projector hands promax its own view, not pro's", () => {
    const of = (family: string) =>
      sweBenchProjector.project({
        benchmarkSuite: "swe-bench",
        datasetFamily: family,
      } as unknown as CanonicalBenchReport)
    expect(of("promax").viewId).toBe("promax")
    expect(of("pro").viewId).toBe("pro")
    expect(of("promax").datasetFamily).toBe("promax")
  })
})

// ── buildReport persists; legacy stays byte-identical ───────────────────────

describe("PMX-05 — buildReport is the ONE writer of the official-grade section", () => {
  test("the persisted totals ARE the canonical example", () => {
    const totals = canonicalReport().officialGrade?.totals
    expect(totals).toBeDefined()
    expect(totals?.assigned).toBe(170)
    expect(totals?.grading_valid).toBe(168)
    expect(totals?.resolved).toBe(65)
    expect(totals?.model_miss).toBe(103)
    expect(totals?.infra_invalid).toBe(2)
    expect(totals?.missing).toBe(0)
    expect(totals?.official_valid_rate).toBe(65 / 168)
    expect(totals?.coverage).toBe(168 / 170)
    expect(totals?.raw_rate).toBe(65 / 170)
  })

  test("the headline totals are NOT derived from the 2 perInstance rows", () => {
    // The report carries 2 InstanceResults and a 170-instance official receipt.
    // If any surface folded rows, `assigned` would be 2.
    const report = canonicalReport()
    expect(report.perInstance).toHaveLength(2)
    expect(report.totals.total).toBe(2)
    expect(report.officialGrade?.totals.assigned).toBe(170)
    // Legacy compatibility outputs still exist and still mean what they meant.
    expect(report.scoreTotals).toBeDefined()
    expect(report.totals.resolved).toBe(1)
  })

  test("a report with NO official grade is byte-identical to the pre-PMX-05 shape", () => {
    const legacy = buildReport(
      { model: "m", provider: "openai", n: 2, datasetFamily: "pro", timestamp: "T" },
      RESULTS,
    )
    expect("officialGrade" in legacy).toBe(false)
    const encoded = encodeCanonicalReport(toCanonicalSweReport(legacy))
    expect(JSON.stringify(encoded, null, 2)).toBe(JSON.stringify(legacy, null, 2))
    expect(JSON.stringify(legacy)).not.toContain("officialGrade")
  })

  test("grader wrapper streams never reach the report body", () => {
    // The evaluator's stdout is grader-only material; the report links artifacts
    // by digest instead of inlining unbounded streams.
    expect(JSON.stringify(canonicalReport())).not.toContain("SECRET-GRADER-STREAM")
  })

  test("real disk round trip preserves EVERY provenance digest", async () => {
    const file = join(TMP, "promax.report.json")
    const report = toCanonicalSweReport(canonicalReport())
    await writeReport(file, report)
    const back = decodeCanonicalReport(JSON.parse(readFileSync(file, "utf8")))
    expect(back.benchmarkSuite).toBe("swe-bench")
    const swe = back as SweBenchReport
    expect(swe.datasetFamily).toBe("promax")
    expect(swe.officialGrade).toEqual(report.officialGrade)
    const digests = (r: SweBenchReport): string[] =>
      (r.officialGrade?.instances ?? []).flatMap((i) => [
        i.raw_artifact?.sha256 ?? "",
        i.prediction_sha256 ?? "",
        i.evaluator.sha256,
        i.image?.registry_digest ?? "",
        i.image?.local_image_id ?? "",
      ])
    expect(digests(swe)).toEqual(digests(report))
    expect(digests(swe)).toHaveLength(170 * 5)
    expect(swe.officialGrade?.evaluator.upstream_commit).toBe(EVALUATOR.upstreamCommit)
  })

  test("decode → encode is BYTE-identical (the section keeps its key position)", async () => {
    // The decoder re-assigns `officialGrade` over the spread rather than
    // appending it, so a decode/encode cycle cannot silently reorder the file.
    const file = join(TMP, "byte-order.report.json")
    // `runHealth` sorts AFTER the section, so `officialGrade` sits in the MIDDLE
    // of the document — an append-instead-of-replace decoder would move it to the
    // tail and the byte comparison below would fail. Without that trailing key the
    // assertion would be satisfied by the very bug it is meant to catch.
    await writeReport(
      file,
      toCanonicalSweReport(
        buildReport(
          {
            model: "gpt-5.5",
            provider: "openai",
            n: 170,
            datasetFamily: "promax",
            timestamp: "T",
            officialGrade: canonicalInput(),
            runHealth: { aborted: false, verdict: "degraded", reason: "r", attempted: 2, total: 2 },
          },
          RESULTS,
        ),
      ),
    )
    const bytes = readFileSync(file, "utf8")
    const keys = Object.keys(JSON.parse(bytes) as Record<string, unknown>)
    expect(keys).toContain("officialGrade")
    expect(keys.at(-1)).toBe("runHealth")
    expect(keys.indexOf("officialGrade")).toBeLessThan(keys.length - 1)
    const round = `${JSON.stringify(encodeCanonicalReport(decodeCanonicalReport(JSON.parse(bytes))), null, 2)}\n`
    expect(round).toBe(bytes)
  })

  test("the generic headline uses the ASSIGNED denominator, never the flattering one", () => {
    // `headline` is rendered where no coverage sits beside it, so it must carry
    // the raw rate. Using `grading_valid` here would be the exact denominator
    // flattery PMX-05 exists to prevent.
    const projected = sweBenchProjector.project(toCanonicalSweReport(canonicalReport()))
    expect(projected.headline).toEqual({ resolved: 65, total: 170 })
    expect(projected.headline?.total).not.toBe(168)
    // A report with no official grade keeps the pre-PMX-05 behaviour (row counting).
    expect(
      sweBenchProjector.project(
        toCanonicalSweReport(buildReport({ model: "m", provider: "o", n: 1 }, RESULTS)),
      ).headline,
    ).toBeUndefined()
  })

  test("RED-ON-INJECTION: a persisted section whose assigned row was dropped is REFUSED", () => {
    const raw = JSON.parse(
      JSON.stringify(encodeCanonicalReport(toCanonicalSweReport(canonicalReport()))),
    )
    // Control: it decodes as written.
    expect(() => decodeCanonicalReport(raw)).not.toThrow()
    raw.officialGrade.totals.assigned = 169
    expect(() => decodeCanonicalReport(raw)).toThrow(OfficialGradePartitionError)
  })
})

// ── one aggregation, four surfaces ──────────────────────────────────────────

describe("PMX-05 — report, CLI, markdown and dashboard show the SAME totals", () => {
  /** Pull every `\d+/\d+`-shaped rate and every headline count out of a surface. */
  const signature = (text: string): string[] => text.match(/\d+\.\d%|\d+\/\d+/g) ?? []

  test("all four surfaces agree, from ONE canonical fixture", () => {
    const report = canonicalReport()
    const section = report.officialGrade
    if (section === undefined) throw new Error("no official grade section")
    const display = formatOfficialGradeTotals(section.totals)

    // 1. the report JSON
    expect(section.totals.assigned).toBe(170)

    // 2. the CLI summary
    const cli = renderOfficialGradeCliLines(section).join("\n")
    // 3. the markdown export
    const md = renderOfficialGradeMarkdown(section)
    // 4. the dashboard — the projector hands the client the SAME display strings.
    const projected = sweBenchProjector.project(toCanonicalSweReport(report))
    const dash = projected.officialGrade
    expect(dash).toBeDefined()
    expect(dash?.totals).toEqual(section.totals)
    expect(dash?.display).toEqual(display)

    for (const surface of [cli, md]) {
      expect(surface).toContain(display.official_valid_rate)
      expect(surface).toContain(display.coverage)
      expect(surface).toContain(display.raw_rate)
      expect(surface).toContain(display.assigned)
    }
    // Byte-identical headline signature across CLI and markdown.
    expect(signature(cli).slice(0, 3)).toEqual(signature(md).slice(0, 3))
    expect(signature(cli).slice(0, 3)).toEqual(["38.7%", "65/168", "98.8%"])
  })

  test("the SHIPPED operator CLI prints the same numbers, from the file on disk", async () => {
    const file = join(TMP, "cli.report.json")
    const report = canonicalReport()
    await writeReport(file, toCanonicalSweReport(report))
    const section = report.officialGrade
    if (section === undefined) throw new Error("no official grade section")
    const display = formatOfficialGradeTotals(section.totals)

    const run = async (args: readonly string[]) => {
      const proc = Bun.spawn(
        ["bun", "run", "tools/leaderboard-dashboard/official-grade-summary.ts", file, ...args],
        { cwd: join(import.meta.dir, "..", "..", "..", ".."), stdout: "pipe", stderr: "pipe" },
      )
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      return { stdout, stderr, code }
    }

    const cli = await run([])
    expect(cli.code).toBe(0)
    expect(cli.stdout).toBe(`${renderOfficialGradeCliLines(section).join("\n")}\n`)
    const md = await run(["--markdown"])
    expect(md.code).toBe(0)
    expect(md.stdout).toBe(renderOfficialGradeMarkdown(section))

    // Byte-identical rates across BOTH shipped surfaces and the persisted totals.
    for (const surface of [cli.stdout, md.stdout]) {
      expect(surface).toContain(display.official_valid_rate)
      expect(surface).toContain(display.coverage)
      expect(surface).toContain(display.raw_rate)
    }
    // Non-vacuity: the CLI really read THIS file (a report with no section is refused).
    const bare = join(TMP, "bare.report.json")
    await writeReport(
      bare,
      toCanonicalSweReport(buildReport({ model: "m", provider: "o", n: 1 }, RESULTS)),
    )
    const refused = Bun.spawn(
      ["bun", "run", "tools/leaderboard-dashboard/official-grade-summary.ts", bare],
      { cwd: join(import.meta.dir, "..", "..", "..", ".."), stdout: "pipe", stderr: "pipe" },
    )
    expect(await refused.exited).toBe(1)
    expect(await new Response(refused.stderr).text()).toContain("no officialGrade section")
  }, 30_000)

  test("no surface re-aggregates: mutating perInstance leaves every headline unmoved", () => {
    const report = canonicalReport()
    const section = report.officialGrade
    if (section === undefined) throw new Error("no official grade section")
    const before = renderOfficialGradeCliLines(section).join("\n")
    // A hostile / buggy consumer rewrites the per-instance rows entirely.
    const mutated: BenchReport = {
      ...report,
      perInstance: [],
      totals: { total: 0, resolved: 0, resolvedPct: 0 },
    }
    const mutatedSection = mutated.officialGrade
    if (mutatedSection === undefined) throw new Error("the mutation dropped the section")
    expect(renderOfficialGradeCliLines(mutatedSection).join("\n")).toBe(before)
    const projected = sweBenchProjector.project(toCanonicalSweReport(mutated))
    expect(projected.officialGrade?.totals.assigned).toBe(170)
    expect(projected.officialGrade?.totals.resolved).toBe(65)
  })
})
