import { describe, expect, test } from "bun:test"
import {
  type BatchBaseResult,
  collectBaseGreenBatched,
  keepBaseGreenDiscoveredTests,
  partitionBaseGreenFromBatch,
} from "@/runner/batch/eval/repo-regression-discovery-adapter"

/**
 * FIX 3 — the base-green witness filter resets ONCE + runs ONE batched pytest,
 * replacing the O(N) per-witness reset+cold-pytest loop, while producing the
 * SAME green/red partition.
 */

// A fixture base-truth: which witness FILES are green on base.
const WITNESSES = ["tests/test_a.py", "tests/test_b.py", "tests/test_c.py", "tests/test_d.py"]
// test_b fails (a function inside it), test_d fails (file-level). a + c are green.
const baseTruth = (w: string): boolean => w === "tests/test_a.py" || w === "tests/test_c.py"

// Per-test port mirrors the legacy path: green ⇒ true, else false.
const perTestPort = async (test: string): Promise<boolean | null> => (baseTruth(test) ? true : null)

// The batch pytest run: failures reported as node-ids (function-level for test_b,
// file-level for test_d) — exactly what pytest emits and parseFailedTests yields.
const batchResultFromTruth = (): BatchBaseResult => ({
  ran: true,
  failed: ["tests/test_b.py::test_thing", "tests/test_d.py"],
})

describe("partitionBaseGreenFromBatch — file-vs-nodeid attribution", () => {
  test("a function-level failure makes its FILE non-green; verdict path is exact", () => {
    const green = partitionBaseGreenFromBatch(WITNESSES, batchResultFromTruth())
    expect(green).toEqual(["tests/test_a.py", "tests/test_c.py"])
  })

  test("EQUIVALENCE: batched verdict partition == per-test partition on the fixture", async () => {
    const batched = partitionBaseGreenFromBatch(WITNESSES, batchResultFromTruth())
    const perTest = await keepBaseGreenDiscoveredTests(WITNESSES, perTestPort)
    expect(batched).toEqual(perTest)
  })

  test("a whole-batch NON-VERDICT ⇒ null (caller must fall back to per-test)", () => {
    expect(partitionBaseGreenFromBatch(WITNESSES, { ran: false, failed: [] })).toBeNull()
  })

  test("file-level failure id (no `::`) attributes to the file too", () => {
    const green = partitionBaseGreenFromBatch(["tests/test_x.py"], {
      ran: true,
      failed: ["tests/test_x.py"],
    })
    expect(green).toEqual([])
  })
})

describe("collectBaseGreenBatched — resets ONCE on the verdict path", () => {
  test("🔴 verdict path: reset called EXACTLY once for N witnesses (was once-per-witness)", async () => {
    let resets = 0
    let perTestCalls = 0
    const green = await collectBaseGreenBatched(WITNESSES, {
      reset: async () => {
        resets += 1
        return true
      },
      runBatch: async () => batchResultFromTruth(),
      perTest: async (t) => {
        perTestCalls += 1
        return baseTruth(t) ? true : null
      },
    })
    // ONE reset for 4 witnesses — the perf fix.
    expect(resets).toBe(1)
    // The batch covered everything; the per-test path was NOT touched.
    expect(perTestCalls).toBe(0)
    // …and the partition is correct.
    expect([...green]).toEqual(["tests/test_a.py", "tests/test_c.py"])
  })

  test("verdict path partition EQUALS the per-test path partition", async () => {
    const batched = await collectBaseGreenBatched(WITNESSES, {
      reset: async () => true,
      runBatch: async () => batchResultFromTruth(),
      perTest: perTestPort,
    })
    const perTest = await keepBaseGreenDiscoveredTests(WITNESSES, perTestPort)
    expect([...batched]).toEqual([...perTest])
  })

  test("NON-VERDICT batch ⇒ falls back to the per-test path (same partition)", async () => {
    let perTestCalls = 0
    const green = await collectBaseGreenBatched(WITNESSES, {
      reset: async () => true,
      runBatch: async () => ({ ran: false, failed: [] }),
      perTest: async (t) => {
        perTestCalls += 1
        return baseTruth(t) ? true : null
      },
    })
    // Fell back: every witness was checked individually.
    expect(perTestCalls).toBe(WITNESSES.length)
    expect([...green]).toEqual(["tests/test_a.py", "tests/test_c.py"])
  })

  test("runBatch null (exec threw) ⇒ per-test fallback, partition preserved", async () => {
    const green = await collectBaseGreenBatched(WITNESSES, {
      reset: async () => true,
      runBatch: async () => null,
      perTest: perTestPort,
    })
    expect([...green]).toEqual(["tests/test_a.py", "tests/test_c.py"])
  })

  test("reset seam unavailable ⇒ per-test fallback (fail-open identical)", async () => {
    let batchRan = false
    const green = await collectBaseGreenBatched(WITNESSES, {
      reset: async () => false,
      runBatch: async () => {
        batchRan = true
        return batchResultFromTruth()
      },
      perTest: perTestPort,
    })
    expect(batchRan).toBe(false)
    expect([...green]).toEqual(["tests/test_a.py", "tests/test_c.py"])
  })

  test("empty witness set ⇒ no reset, no run", async () => {
    let resets = 0
    const green = await collectBaseGreenBatched([], {
      reset: async () => {
        resets += 1
        return true
      },
      runBatch: async () => batchResultFromTruth(),
      perTest: perTestPort,
    })
    expect(resets).toBe(0)
    expect([...green]).toEqual([])
  })
})
