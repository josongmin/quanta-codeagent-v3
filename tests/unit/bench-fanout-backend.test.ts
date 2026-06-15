/**
 * RED-first hellgate for the K-way fan-out grading backend (ADR-0536 P2).
 * Written BEFORE fanout.ts exists. Core scenarios:
 *   1. K shards split balanced, each backend called once with its shard + per-shard runId, merged union
 *   2. shards=1 ⇒ single passthrough (no sharding)
 *   3. shards > line count ⇒ only non-empty shards run (no empty-shard crash)
 *   4. one shard backend throws ⇒ its instances errored, other shards still merged (no total failure)
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { GradeBackend, GradeOutcome } from "../../src/apps/bench/remote/backend"
import { createFanoutBackend } from "../../src/apps/bench/remote/fanout"

const predsFile = (ids: string[]): string => {
  const dir = mkdtempSync(join(tmpdir(), "fanout-"))
  const p = join(dir, "preds.jsonl")
  writeFileSync(
    p,
    `${ids.map((id) => JSON.stringify({ instance_id: id, model_patch: "d" })).join("\n")}\n`,
  )
  return p
}

/** Mock backend: resolves every instance id it sees in its shard file. Records calls. */
const recordingBackend = (calls: { path: string; runId: string }[]): GradeBackend => ({
  name: "mock",
  grade: async (predictionsPath, opts): Promise<GradeOutcome> => {
    calls.push({ path: predictionsPath, runId: opts.runId })
    const ids = (await Bun.file(predictionsPath).text())
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => (JSON.parse(l) as { instance_id: string }).instance_id)
    return {
      reportPath: `${predictionsPath}.report.json`,
      resolved: ids,
      unresolved: [],
      errored: [],
      emptyPatch: [],
    }
  },
})

describe("fan-out backend", () => {
  test("K=3 splits balanced, one call per shard, merged union of resolved", async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `inst-${i}`)
    const calls: { path: string; runId: string }[] = []
    const backend = createFanoutBackend({ shards: 3, makeBackend: () => recordingBackend(calls) })
    const out = await backend.grade(predsFile(ids), { datasetPath: "ds.jsonl", runId: "run" })
    expect(calls.length).toBe(3) // 3 shards each graded once
    expect(new Set(out.resolved)).toEqual(new Set(ids)) // union covers all
    expect(out.resolved.length).toBe(10)
    // per-shard run ids derived from the base run id
    expect(calls.every((c) => c.runId.startsWith("run-s"))).toBe(true)
  })

  test("shards=1 ⇒ single passthrough", async () => {
    const calls: { path: string; runId: string }[] = []
    const backend = createFanoutBackend({ shards: 1, makeBackend: () => recordingBackend(calls) })
    const out = await backend.grade(predsFile(["a", "b"]), { datasetPath: "ds", runId: "run" })
    expect(calls.length).toBe(1)
    expect(new Set(out.resolved)).toEqual(new Set(["a", "b"]))
  })

  test("shards > line count ⇒ only non-empty shards run", async () => {
    const calls: { path: string; runId: string }[] = []
    const backend = createFanoutBackend({ shards: 5, makeBackend: () => recordingBackend(calls) })
    await backend.grade(predsFile(["a", "b"]), { datasetPath: "ds", runId: "run" })
    expect(calls.length).toBe(2) // 2 preds ⇒ at most 2 non-empty shards
  })

  test("one shard throws ⇒ its instances errored, others merged (no total failure)", async () => {
    const ids = Array.from({ length: 6 }, (_, i) => `i-${i}`)
    let shardN = 0
    const backend = createFanoutBackend({
      shards: 2,
      makeBackend: () => {
        const isFailing = shardN++ === 0
        return {
          name: "mock",
          grade: async (predictionsPath, _opts): Promise<GradeOutcome> => {
            if (isFailing) throw new Error("shard boom")
            const sids = (await Bun.file(predictionsPath).text())
              .split("\n")
              .filter((l) => l.trim() !== "")
              .map((l) => (JSON.parse(l) as { instance_id: string }).instance_id)
            return { reportPath: "r", resolved: sids, unresolved: [], errored: [], emptyPatch: [] }
          },
        }
      },
    })
    const out = await backend.grade(predsFile(ids), { datasetPath: "ds", runId: "run" })
    // The whole run did NOT reject; the failing shard's instances are errored,
    // the surviving shard's are resolved.
    expect(out.errored.length).toBeGreaterThan(0)
    expect(out.resolved.length).toBeGreaterThan(0)
    expect(out.resolved.length + out.errored.length).toBe(6)
  })
})
