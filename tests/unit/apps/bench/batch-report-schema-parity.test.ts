import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeArtifacts } from "../../../../src/apps/bench/index"
import type { InstanceResult } from "../../../../src/apps/bench/types"
import { __resetRuntimeConfig } from "../../../../src/shared/runtime-config"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..")
const read = (path: string): string => readFileSync(join(REPO_ROOT, path), "utf8")

/** Test isolation: `writeArtifacts` → `writeReport` → `mirrorReportToSsot`, whose
 *  DEFAULT sink is the operator's LIVE `~/.quanta/bench/results` SSOT. The
 *  per-test `mkdtempSync` dirs below isolate the report FILE but not the mirror,
 *  so each run of this file deposited 4 `tmp__batch-report-parity-*` artifacts
 *  into the real leaderboard corpus (measured: 4034 → 4038 in one run). Redirect
 *  the mirror for the whole file — the canonical writer is still exercised
 *  end-to-end, nothing escapes the sandbox. `__resetRuntimeConfig` is required on
 *  both edges because the resolved config is memoised. */
let ssotDir: string
let priorResultsDir: string | undefined

beforeAll(() => {
  ssotDir = mkdtempSync(join(tmpdir(), "batch-report-parity-ssot-"))
  priorResultsDir = process.env.QUANTA_BENCH_RESULTS_DIR
  process.env.QUANTA_BENCH_RESULTS_DIR = ssotDir
  __resetRuntimeConfig()
})

afterAll(() => {
  if (priorResultsDir === undefined) delete process.env.QUANTA_BENCH_RESULTS_DIR
  else process.env.QUANTA_BENCH_RESULTS_DIR = priorResultsDir
  __resetRuntimeConfig()
  rmSync(ssotDir, { recursive: true, force: true })
})

const mkResult = (id: string, passed: boolean, patch: string): InstanceResult => ({
  id,
  passed,
  patch,
  turns: 1,
})

describe("T5 batch report schema parity", () => {
  test("bench surface keeps report ownership outside the sdk runtime", () => {
    const source = read("src/apps/bench/run-main-helpers.ts")

    expect(source).toContain("writeBatchArtifacts")
    expect(source).toContain("export const writeArtifacts = async")
  })

  test("predictions jsonl keeps the official field names", async () => {
    const dir = mkdtempSync(join(tmpdir(), "batch-report-parity-"))
    try {
      const predictionsFile = join(dir, "predictions.jsonl")
      const reportFile = join(dir, "report.json")
      await writeArtifacts(predictionsFile, reportFile, [mkResult("x", false, "")], {
        provider: "openai",
        model: "gpt-test",
        n: 1,
      })

      expect(existsSync(predictionsFile)).toBe(true)
      const line = JSON.parse(readFileSync(predictionsFile, "utf8").trim()) as Record<
        string,
        unknown
      >
      expect(Object.keys(line).sort()).toEqual(["instance_id", "model_name_or_path", "model_patch"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("writeArtifacts threads datasetFamily into the report (BFND-02 drop fix)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "batch-report-parity-"))
    try {
      const predictionsFile = join(dir, "predictions.jsonl")
      const reportFile = join(dir, "report.json")
      // The bench-side writeArtifacts previously DROPPED datasetFamily — the
      // report was written without the family discriminator. BFND-02 threads it.
      await writeArtifacts(predictionsFile, reportFile, [mkResult("x", true, "p")], {
        provider: "openai",
        model: "gpt-test",
        n: 1,
        datasetFamily: "pro",
      })
      const report = JSON.parse(readFileSync(reportFile, "utf8")) as Record<string, unknown>
      // The bench-side writeArtifacts now FORWARDS the family (was dropped pre-BFND-02).
      expect(report.datasetFamily).toBe("pro")
      // ...and the SWE branch keeps its LEGACY persisted encoding: identity is
      // implicit on disk and materialized at the one read boundary, so the bytes
      // stay byte-identical to a pre-BFND-02 report.
      expect("benchmarkSuite" in report).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("writeArtifacts on a verified (absent-family) run stays byte-identical (no family key)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "batch-report-parity-"))
    try {
      const predictionsFile = join(dir, "predictions.jsonl")
      const reportFile = join(dir, "report.json")
      // Absent selector ⇒ verified ⇒ datasetFamily key omitted (byte-identical guard).
      await writeArtifacts(predictionsFile, reportFile, [mkResult("x", true, "p")], {
        provider: "openai",
        model: "gpt-test",
        n: 1,
      })
      const report = JSON.parse(readFileSync(reportFile, "utf8")) as Record<string, unknown>
      // The verified byte-identical invariant: no datasetFamily, no benchmarkSuite emitted.
      expect("datasetFamily" in report).toBe(false)
      expect("benchmarkSuite" in report).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("report json keeps totals, scoreTotals, proofTotals, llmEvidenceTotals, perInstance, and failureBreakdown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "batch-report-parity-"))
    try {
      const predictionsFile = join(dir, "predictions.jsonl")
      const reportFile = join(dir, "report.json")
      await writeArtifacts(
        predictionsFile,
        reportFile,
        [mkResult("a", true, "p1"), mkResult("b", false, "")],
        {
          provider: "openai",
          model: "gpt-test",
          n: 1,
        },
      )

      expect(existsSync(reportFile)).toBe(true)
      const report = JSON.parse(readFileSync(reportFile, "utf8")) as Record<string, unknown>
      expect("totals" in report).toBe(true)
      expect("scoreTotals" in report).toBe(true)
      expect("proofTotals" in report).toBe(true)
      expect("llmEvidenceTotals" in report).toBe(true)
      expect("perInstance" in report).toBe(true)
      expect("failureBreakdown" in report).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
