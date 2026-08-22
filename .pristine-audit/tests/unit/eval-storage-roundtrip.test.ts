/**
 * Storage roundtrip — append → drain → readAll → matrix render.
 * Uses a temp dir so the test never touches `evals/runs/`.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildCoverageMatrix } from "@/../src/apps/eval/report/coverage-matrix"
import { renderMatrixMarkdown } from "@/../src/apps/eval/report/markdown"
import { makeRunId, ResultStore } from "@/../src/apps/eval/storage"

describe("eval storage roundtrip", () => {
  test("append then drain then readAll yields the same records", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-store-"))
    const store = new ResultStore({ dir, now: () => 1234 })
    const runId = makeRunId("audit", () => 1_700_000_000_000)
    const first = {
      tier: "audit",
      usecase: "software-quality.debugging.error-message-paste",
      payload: { kind: "audit", coverage: "ok", evidence: ["src/agent/loop.ts"] },
    } as const
    const second = {
      tier: "synthetic",
      usecase: "software-quality.testing.unit-gen",
      payload: {
        kind: "synthetic",
        scenarioId: "pure-function-tests",
        verdict: "pass",
        score: 1,
        rubric: [{ name: "covers-happy-path", pass: true }],
        toolsUsed: ["Read", "Write", "bash"],
        durationMs: 1234,
      },
    } as const
    await store.append(runId, first)
    await store.append(runId, second)
    await store.drain()
    const records = [...new ResultStore({ dir }).readAll()]
    expect(records).toEqual([
      { ts: 1234, schema: 1, runId, ...first },
      { ts: 1234, schema: 1, runId, ...second },
    ])
    const matrix = buildCoverageMatrix(records)
    const md = renderMatrixMarkdown(matrix)
    expect(md).toContain("software-quality.debugging.error-message-paste")
    expect(md).toContain("software-quality.testing.unit-gen")
    expect(md).toContain("OK")
  })
})
