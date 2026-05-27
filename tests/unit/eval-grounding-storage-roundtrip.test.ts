import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildCoverageMatrix } from "@/../src/apps/eval/report/coverage-matrix"
import { makeRunId, ResultStore } from "@/../src/apps/eval/storage"

describe("grounding storage roundtrip", () => {
  test("grounding payload persists and contributes to the matrix/token rollup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-grounding-store-"))
    const store = new ResultStore({ dir, now: () => 4567 })
    const runId = makeRunId("grounding", () => 1_700_000_000_000)
    await store.append(runId, {
      tier: "grounding",
      usecase: "persistent-context.conversation-state.thread-grounding",
      payload: {
        kind: "grounding",
        suite: "canary",
        caseId: "prompt-rules-status-raw",
        verdict: "pass",
        bucket: "ellipsis",
        severity: "critical",
        gold: {
          activeThreadId: "prompt_rules",
          referentId: "prompt_rules",
          intent: "status_check",
          scope: "current_workstream",
          shouldClarify: false,
          confidence: "high",
        },
        actual: {
          activeThreadId: "prompt_rules",
          referentId: "prompt_rules",
          intent: "status_check",
          scope: "current_workstream",
          shouldClarify: false,
          confidence: "high",
        },
        matches: {
          activeThread: true,
          referent: true,
          intent: true,
          scope: true,
          shouldClarify: true,
          exactTuple: true,
          wrongThread: false,
          mustClarifyMiss: false,
          staleContextTrapMiss: false,
        },
        rawResponse: "{}",
        durationMs: 88,
        tokens: { prompt: 10, completion: 3, cacheRead: 2 },
        costUsd: 0.123,
      },
    })
    await store.drain()

    const records = [...new ResultStore({ dir }).readAll()]
    expect(records).toHaveLength(1)
    expect(records[0]?.payload.kind).toBe("grounding")

    const matrix = buildCoverageMatrix(records)
    expect(matrix.tokenCost).toEqual({
      prompt: 10,
      completion: 3,
      cacheRead: 2,
      costUsd: 0.123,
      records: 1,
    })
    const row = matrix.blocks
      .flatMap((block) => block.rows)
      .find((candidate) => candidate.id === "persistent-context.conversation-state.thread-grounding")
    expect(row?.cells.grounding.verdict).toBe("pass")
    expect(row?.cells.grounding.count).toBe(1)
  })
})
