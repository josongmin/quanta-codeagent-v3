/**
 * Hellgate: bench instance-level concurrency (patch-gen parallel, grading
 * serial). Two invariants that MUST hold together:
 *
 *   1. `mapWithConcurrency` overlaps up to `limit` items, NEVER more, and
 *      ALWAYS returns results in input order (results[i] ↔ items[i]) regardless
 *      of completion order. `limit<=1` ⇒ strictly serial (byte-identical to the
 *      old `for await` loop).
 *   2. The python-swebench GRADING mutex serialises actual `run_evaluation`
 *      spawns even when many evaluations run concurrently — arm64 Docker wedges
 *      on parallel large image pulls, so grading must be one-at-a-time.
 *
 * Red-on-injection: drop the `withGradingLock` wrapper and test PART-2's
 * "max concurrent grading == 1" assertion fails (spawns overlap).
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

describe("grading mutex — run_evaluation spawns never overlap", () => {
  const benchInstance = (id: string): Instance => ({
    id,
    repoPath: "/tmp/x",
    problemStatement: "fix it",
    testCmd: "true",
    swebench: { instanceId: id, repo: "x/x", baseCommit: "deadbeef" },
  })

  test("N concurrent evaluations ⇒ at most ONE run_evaluation spawn at a time", async () => {
    let inFlight = 0
    let peak = 0
    let runEvalSpawns = 0
    // Fake spawn: only the run_evaluation argv reaches here (import-check is
    // short-circuited via `probe`). Each spawn holds for a tick so genuine
    // overlap WOULD be observed if the mutex were absent.
    const fakeSpawn = async (argv: string[]) => {
      const isRunEval = argv.some((a) => a.includes("run_evaluation"))
      if (isRunEval) {
        runEvalSpawns += 1
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await tick(20)
        inFlight -= 1
      }
      return { code: 0, stdout: "Instances completed: 1", stderr: "" }
    }
    const opts = {
      probe: async () => true, // import-check passes without spawning
      spawn: fakeSpawn,
      datasetName: "dummy",
    }
    // Fire 4 evaluations CONCURRENTLY (this is what concurrency>1 does).
    await Promise.all(
      ["a__1", "b__2", "c__3", "d__4"].map((id) =>
        evaluateWithPythonSwebench(benchInstance(id), "diff --git a b\n+x", opts),
      ),
    )
    expect(runEvalSpawns).toBe(4) // all four did grade
    expect(peak).toBe(1) // ...but never two at once (mutex held)
  })
})
