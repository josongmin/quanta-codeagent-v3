/**
 * Hellgate: bench instance-level concurrency (patch-gen parallel, grading
 * serial). Two invariants that MUST hold together:
 *
 *   1. `mapWithConcurrency` overlaps up to `limit` items, NEVER more, and
 *      ALWAYS returns results in input order (results[i] ↔ items[i]) regardless
 *      of completion order. `limit<=1` ⇒ strictly serial (byte-identical to the
 *      old `for await` loop).
 *   2. The python-swebench GRADING mutex serialises actual `run_evaluation`
 *      spawns — ALWAYS one-at-a-time, NOT configurable. Concurrent on-box grading
 *      false-negatives correct patches (2026-06-19: GRADE_CONCURRENCY=6 scored
 *      0/5 vs 4/5 serial), so grading is intentionally serial.
 *
 * Red-on-injection: drop the `withGradingLock` wrapper and PART-2's "peak == 1"
 * assertion fails (spawns overlap).
 */
import { describe, expect, test } from "bun:test"
import { evaluateWithPythonSwebench } from "../../src/apps/bench/python-swebench"
import type { Instance } from "../../src/apps/bench/types"
import { mapWithConcurrency } from "../../src/runner/batch/core"

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("mapWithConcurrency — order + bounded parallelism", () => {
  test("preserves input order regardless of completion order", async () => {
    // Item 0 finishes LAST (longest delay) — proves ordering is by index, not
    // by completion.
    const delays = [40, 5, 25, 1, 15]
    const out = await mapWithConcurrency(delays, 3, async (d, i) => {
      await tick(d)
      return i
    })
    expect(out).toEqual([0, 1, 2, 3, 4])
  })

  test("never exceeds the concurrency limit", async () => {
    let inFlight = 0
    let peak = 0
    await mapWithConcurrency(
      Array.from({ length: 12 }, (_, i) => i),
      4,
      async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await tick(5)
        inFlight -= 1
      },
    )
    expect(peak).toBeLessThanOrEqual(4)
    expect(peak).toBeGreaterThan(1) // actually parallelised (not accidentally serial)
  })

  test("limit<=1 is strictly serial (peak in-flight == 1)", async () => {
    let inFlight = 0
    let peak = 0
    const order: number[] = []
    await mapWithConcurrency([0, 1, 2, 3], 1, async (_v, i) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await tick(3)
      order.push(i)
      inFlight -= 1
    })
    expect(peak).toBe(1)
    expect(order).toEqual([0, 1, 2, 3]) // serial completion in index order
  })

  test("empty input ⇒ empty output, no workers spawned", async () => {
    let calls = 0
    const out = await mapWithConcurrency([], 8, async () => {
      calls += 1
      return 1
    })
    expect(out).toEqual([])
    expect(calls).toBe(0)
  })
})

describe("grading mutex — run_evaluation spawns are ALWAYS serial", () => {
  const benchInstance = (id: string): Instance => ({
    id,
    repoPath: "/tmp/x",
    problemStatement: "fix it",
    testCmd: "true",
    swebench: { instanceId: id, repo: "x/x", baseCommit: "deadbeef" },
  })

  // Fire `ids` graded CONCURRENTLY (what concurrency>1 does) and report the peak
  // number of run_evaluation spawns observed in flight at once. Each fake spawn
  // holds for a tick so genuine overlap WOULD be observed if the bound were absent.
  const peakConcurrentGrades = async (ids: string[]): Promise<{ peak: number; spawns: number }> => {
    let inFlight = 0
    let peak = 0
    let spawns = 0
    const fakeSpawn = async (argv: string[]) => {
      if (argv.some((a) => a.includes("run_evaluation"))) {
        spawns += 1
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await tick(20)
        inFlight -= 1
      }
      return { code: 0, stdout: "Instances completed: 1", stderr: "" }
    }
    const opts = { probe: async () => true, spawn: fakeSpawn, datasetName: "dummy" }
    await Promise.all(
      ids.map((id) => evaluateWithPythonSwebench(benchInstance(id), "diff --git a b\n+x", opts)),
    )
    return { peak, spawns }
  }

  test("N concurrent evaluations ⇒ at most ONE run_evaluation spawn at a time", async () => {
    // Concurrent on-box grading false-negatives correct patches (2026-06-19:
    // GRADE_CONCURRENCY=6 scored 0/5 vs 4/5 serial, 3 gold-identical), so grading
    // is intentionally serial and NOT configurable. Red-on-injection: drop the
    // withGradingLock wrapper and peak jumps to 4.
    const { peak, spawns } = await peakConcurrentGrades(["a__1", "b__2", "c__3", "d__4"])
    expect(spawns).toBe(4) // all four graded
    expect(peak).toBe(1) // ...but never two at once (mutex held)
  })
})
