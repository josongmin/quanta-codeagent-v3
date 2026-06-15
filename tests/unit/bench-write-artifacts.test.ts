/**
 * D-fix regression pin: `writeArtifacts` MUST write both the predictions
 * JSONL and the report JSON given explicit paths, AND the report MUST carry
 * the structured failure classification (failureBreakdown + perInstance.failure).
 *
 * The bug it closes: `runCustomCorpusMode` previously skipped these writes
 * entirely, so `--report /tmp/X.json` was silently ignored when the bench
 * ran against a `--corpus <dir>` (not the official dataset). After-the-fact
 * triage of "WHY did the agent FAIL" was impossible without the per-instance
 * patch + classification.
 *
 * The structural fix introduced `writeArtifacts(predFile, reportFile, results, meta)`
 * — pure-by-signature, no argv reads — and both modes now route through it.
 * This test exercises the helper directly so adding a third mode (e.g. an
 * eval-bench wrapper) cannot regress the contract.
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeArtifacts } from "@/../src/apps/bench/index"
import type { InstanceResult } from "@/../src/apps/bench/types"

const mkResult = (id: string, passed: boolean, patch: string): InstanceResult => ({
  id,
  passed,
  patch,
  turns: 1,
})

describe("writeArtifacts (D-fix)", () => {
  test("writes predictions JSONL with one line per result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-art-"))
    try {
      const predFile = join(dir, "preds.jsonl")
      const reportFile = join(dir, "report.json")
      const results: InstanceResult[] = [
        mkResult("django__django-11179", true, "diff --git a/x.py\n+ pass"),
        mkResult("psf__requests-1921", false, ""),
      ]
      await writeArtifacts(predFile, reportFile, results, {
        provider: "openai",
        model: "gpt-test",
        n: 1,
      })
      expect(existsSync(predFile)).toBe(true)
      const lines = readFileSync(predFile, "utf8").trim().split("\n")
      expect(lines).toHaveLength(2)
      const first = JSON.parse(lines[0] as string) as Record<string, unknown>
      expect(first.instance_id).toBe("django__django-11179")
      expect(first.model_name_or_path).toBe("gpt-test")
      expect(first.model_patch).toContain("diff --git a/x.py")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("writes report JSON with totals + perInstance + failure classification", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-art-"))
    try {
      const predFile = join(dir, "preds.jsonl")
      const reportFile = join(dir, "report.json")
      const results: InstanceResult[] = [
        mkResult("a", true, "p1"),
        mkResult("b", false, ""),
        mkResult("c", false, "p3"),
      ]
      await writeArtifacts(predFile, reportFile, results, {
        provider: "openai",
        model: "gpt-test",
        n: 1,
      })
      expect(existsSync(reportFile)).toBe(true)
      const report = JSON.parse(readFileSync(reportFile, "utf8")) as {
        totals: { total: number; resolved: number; resolvedPct: number }
        failureBreakdown: {
          byTermination: Record<string, number>
          bySignal: Record<string, number>
        }
        perInstance: {
          id: string
          passed: boolean
          failure?: { termination: string; signals: string[] }
        }[]
      }
      expect(report.totals.total).toBe(3)
      expect(report.totals.resolved).toBe(1)
      expect(report.totals.resolvedPct).toBe(33)
      expect(report.perInstance.map((r) => r.id)).toEqual(["a", "b", "c"])
      expect(report.perInstance.map((r) => r.passed)).toEqual([true, false, false])
      // Failure classification on each failed result. No trajectory files
      // exist for these synthetic results, so termination falls back to
      // "unknown" — that IS the deterministic contract.
      expect(report.perInstance[0]?.failure).toBeUndefined()
      // "b" has empty patch + turns>0 → classifier identifies it as
      // completed_unresolved (agent ran but produced no patch), NOT "unknown".
      expect(report.perInstance[1]?.failure?.termination).toBe("completed_unresolved")
      // "c" has a non-empty patch + no trajectory → falls back to "unknown".
      expect(report.perInstance[2]?.failure?.termination).toBe("unknown")
      // Aggregated breakdown: 1 completed_unresolved, 1 unknown.
      expect(report.failureBreakdown.byTermination.completed_unresolved).toBe(1)
      expect(report.failureBreakdown.byTermination.unknown).toBe(1)
      // b's empty patch yields the empty_patch signal (c's non-empty doesn't).
      expect(report.failureBreakdown.bySignal.empty_patch).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("predictions for a failed run still carry whatever patch was produced (empty allowed)", async () => {
    // The D-fix matters most for FAIL cases — triage needs the patch even
    // (especially) when the run didn't pass. Verify empty patches survive.
    const dir = mkdtempSync(join(tmpdir(), "bench-art-"))
    try {
      const predFile = join(dir, "preds.jsonl")
      const reportFile = join(dir, "report.json")
      await writeArtifacts(predFile, reportFile, [mkResult("x", false, "")], {
        provider: "openai",
        model: "gpt-test",
        n: 1,
      })
      const line = JSON.parse(readFileSync(predFile, "utf8").trim()) as Record<string, unknown>
      expect(line.model_patch).toBe("")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
