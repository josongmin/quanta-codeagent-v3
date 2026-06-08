import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeArtifacts } from "../../../../src/apps/bench/index"
import type { InstanceResult } from "../../../../src/apps/bench/types"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..")
const read = (path: string): string => readFileSync(join(REPO_ROOT, path), "utf8")

const mkResult = (id: string, passed: boolean, patch: string): InstanceResult => ({
  id,
  passed,
  patch,
  turns: 1,
})

describe("T5 batch report schema parity", () => {
  test("bench surface keeps report ownership outside the sdk runtime", () => {
    const source = read("src/apps/bench/index.ts")

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

  test("report json keeps totals, perInstance, and failureBreakdown", async () => {
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
      expect("perInstance" in report).toBe(true)
      expect("failureBreakdown" in report).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
