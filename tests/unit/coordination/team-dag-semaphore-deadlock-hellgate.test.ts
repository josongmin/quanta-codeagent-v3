/**
 * ★ HELLGATE — Capability A: DAG gate × admission-semaphore interplay (the
 *   PRODUCTION direct-gate path through `runBatch`'s `dagGateFactory`, NOT the
 *   `wrapRunnerWithDagGate` wrapper). The concurrency / resource invariants:
 *
 *   (#4 self-deadlock) A diamond DAG under a concurrency cap of 1 MUST still
 *     complete — the blocked-item gate `await` happens OUTSIDE the semaphore, so
 *     a parked dependent never holds the single worker slot its own dependency
 *     needs to acquire. A regression that moved the gate `await` inside the slot
 *     would self-deadlock here (cap=1: A holds the only slot, B parks holding a
 *     slot it can never get → hang).
 *
 *   (slot-not-held) With cap=1 and W independent items each depending on a single
 *     root, the root must dispatch FIRST and every dependent in turn — the pool
 *     never starves because parked dependents hold no slot.
 *
 *   (deps-first under tight cap) cap < DAG width must still order deps-first.
 *
 *   No LLM, no disk, no real timers — the REAL `createDagGate` threaded through
 *   the REAL `runBatch` via the production `dagGateFactory` shape.
 */
import { describe, expect, test } from "bun:test"
import { createDagGate } from "@/subagent/coordination"
import type {
  BatchDagGateFactory,
  BatchSubagentRunner,
  RunBatchArgs,
  SubagentBatchDeps,
} from "@/tool/subagent-batch"
import { runBatch } from "@/tool/subagent-batch"

const liveFactory: BatchDagGateFactory = (nodes) => {
  const made = createDagGate(nodes)
  if (!made.ok) return { ok: false, reason: `${made.reason}: ${made.cycle.join(" -> ")}` }
  return { ok: true, gate: made.gate }
}

/** Records dispatch order + the MAX observed concurrency (so we can prove the
 *  cap is honored AND that no slot is wasted on a parked dependent). */
const mkRunner = (): {
  runner: BatchSubagentRunner
  order: string[]
  maxInFlight: () => number
} => {
  const order: string[] = []
  let inFlight = 0
  let peak = 0
  const runner: BatchSubagentRunner = async (req) => {
    const id = req.prompt.replace(/^id::/, "")
    order.push(id)
    inFlight++
    peak = Math.max(peak, inFlight)
    // Yield a couple of microtasks so overlapping dispatch (if any) is observable.
    await Promise.resolve()
    await Promise.resolve()
    inFlight--
    return { ok: true, finalText: `done ${id}`, turns: 1 }
  }
  return { runner, order, maxInFlight: () => peak }
}

const baseDeps = (
  runner: BatchSubagentRunner,
  cap: number,
  factory: BatchDagGateFactory,
): SubagentBatchDeps => ({
  runner,
  clock: () => 0,
  maxItems: 100,
  schedulerCap: cap,
  timeoutPolicy: { minMs: 1, maxMs: 1000, defaultMs: 1000 },
  dagGateFactory: factory,
})

const args = (
  ids: readonly string[],
  dependencies: Record<string, readonly string[]>,
  cap: number,
): RunBatchArgs => ({
  items: ids.map((id) => ({ id })),
  promptTemplate: "id::{{id}}",
  idField: "id",
  maxConcurrency: cap,
  dependencies,
})

const never = new AbortController().signal

describe("HELLGATE A — DAG × semaphore (no self-deadlock under a tight cap)", () => {
  // The headline self-deadlock attack: cap=1 + diamond. If a parked dependent
  // held the single slot, A would never release it to B → hang. Must complete.
  test("cap=1 diamond A→{B,C}→D completes (gate await is OUTSIDE the slot)", async () => {
    const { runner, order, maxInFlight } = mkRunner()
    const run = await runBatch(
      args(["A", "B", "C", "D"], { B: ["A"], C: ["A"], D: ["B", "C"] }, 1),
      baseDeps(runner, 1, liveFactory),
      never,
    )
    expect(run.summary.ok).toBe(4) // ALL completed — no hang
    expect(maxInFlight()).toBe(1) // cap honored
    // deps-first even at cap=1: A first, D last, B/C between.
    expect(order[0]).toBe("A")
    expect(order[3]).toBe("D")
    expect(order.indexOf("B")).toBeGreaterThan(order.indexOf("A"))
    expect(order.indexOf("C")).toBeGreaterThan(order.indexOf("A"))
  })

  // cap=1 + a wide fan-out where W items each depend on a single root: the root
  // must run FIRST and free the slot for each dependent — proves a parked
  // dependent never starves the pool by squatting on a slot.
  test("cap=1 wide fan-out (root + 6 dependents) completes, root dispatched first", async () => {
    const deps = { B: ["A"], C: ["A"], D: ["A"], E: ["A"], F: ["A"], G: ["A"] }
    const { runner, order, maxInFlight } = mkRunner()
    const run = await runBatch(
      args(["A", "B", "C", "D", "E", "F", "G"], deps, 1),
      baseDeps(runner, 1, liveFactory),
      never,
    )
    expect(run.summary.ok).toBe(7)
    expect(maxInFlight()).toBe(1)
    expect(order[0]).toBe("A") // root first; all others gated behind it
  })

  // cap=2 < DAG width (4 independent roots feeding one sink): must honor BOTH
  // the cap (≤2 in flight) AND deps-first (sink last). A tight cap must not
  // reorder a dependent ahead of its dep.
  test("cap=2 fan-in (4 roots → 1 sink) honors cap AND deps-first", async () => {
    const { runner, order, maxInFlight } = mkRunner()
    const run = await runBatch(
      args(["A", "B", "C", "D", "Z"], { Z: ["A", "B", "C", "D"] }, 2),
      baseDeps(runner, 2, liveFactory),
      never,
    )
    expect(run.summary.ok).toBe(5)
    expect(maxInFlight()).toBeLessThanOrEqual(2) // cap never exceeded
    expect(order.at(-1)).toBe("Z") // sink dispatched only after all 4 deps
  })

  // A blocked (dead-branch) dependent under cap=1 must settle WITHOUT ever
  // acquiring a slot — the failed root frees the slot and the dependent resolves
  // "blocked" off the gate (outside the semaphore), so the batch terminates.
  test("cap=1 dead branch settles without deadlock (blocked item never takes a slot)", async () => {
    const order: string[] = []
    const runner: BatchSubagentRunner = async (req) => {
      const id = req.prompt.replace(/^id::/, "")
      order.push(id)
      return id === "A"
        ? { ok: false, finalText: "boom", turns: 1 } // root fails
        : { ok: true, finalText: "done", turns: 1 }
    }
    const run = await runBatch(
      args(["A", "B"], { B: ["A"] }, 1),
      baseDeps(runner, 1, liveFactory),
      never,
    )
    expect(order).toEqual(["A"]) // B blocked, never dispatched
    expect(run.summary.failed).toBe(2)
  })
})
