/**
 * E2E hellgate — Capability A LIVE: the REAL `@/subagent/coordination` DAG gate
 * driving the REAL `@/tool/subagent-batch` dispatch loop (`runBatch`).
 *
 * This is the test that proves the wire is NOT a no-op: a `spawn_batch` whose
 * `dependencies` declare edges now orders fan-out deps-first, blocks dead
 * branches, and refuses a cyclic graph — all via the production `createDagGate`
 * core threaded through `runBatch`'s `dagGateFactory`.
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

/** The production factory: adapts the REAL `createDagGate` to the batch port. */
const liveFactory: BatchDagGateFactory = (nodes) => {
  const made = createDagGate(nodes)
  if (!made.ok) return { ok: false, reason: `${made.reason}: ${made.cycle.join(" -> ")}` }
  return { ok: true, gate: made.gate }
}

/** A runner that records dispatch order + can be scripted to fail per id. The
 *  child prompt is `id::<id>` so we recover the id (mirrors the composition
 *  root's id-in-prompt convention; here we parse it back). */
const mkRunner = (
  fail: ReadonlySet<string> = new Set(),
): { runner: BatchSubagentRunner; order: string[] } => {
  const order: string[] = []
  const runner: BatchSubagentRunner = async (req) => {
    const id = req.prompt.replace(/^id::/, "")
    order.push(id)
    if (fail.has(id)) return { ok: false, finalText: `boom ${id}`, turns: 1 }
    return { ok: true, finalText: `done ${id}`, turns: 1 }
  }
  return { runner, order }
}

const baseDeps = (
  runner: BatchSubagentRunner,
  factory?: BatchDagGateFactory,
): SubagentBatchDeps => ({
  runner,
  clock: () => 0,
  maxItems: 100,
  schedulerCap: 8,
  timeoutPolicy: { minMs: 1, maxMs: 1000, defaultMs: 1000 },
  ...(factory !== undefined ? { dagGateFactory: factory } : {}),
})

/** Items are objects `{id}`; the prompt template renders `id::{{id}}` so the
 *  runner can recover the id, and `id_field:"id"` makes the DAG node id = item id. */
const args = (
  ids: readonly string[],
  dependencies?: Record<string, readonly string[]>,
): RunBatchArgs => ({
  items: ids.map((id) => ({ id })),
  promptTemplate: "id::{{id}}",
  idField: "id",
  maxConcurrency: 8,
  ...(dependencies !== undefined ? { dependencies } : {}),
})

const never = new AbortController().signal

describe("Capability A LIVE — DAG gate drives spawn_batch dispatch", () => {
  test("deps-first ordering: B depends on A ⇒ A dispatched before B", async () => {
    const { runner, order } = mkRunner()
    const run = await runBatch(args(["A", "B"], { B: ["A"] }), baseDeps(runner, liveFactory), never)
    expect(run.summary.ok).toBe(2)
    expect(order).toEqual(["A", "B"]) // strict order despite concurrency 8
  })

  test("diamond: D waits for B AND C, which both wait for A", async () => {
    const { runner, order } = mkRunner()
    const run = await runBatch(
      args(["A", "B", "C", "D"], { B: ["A"], C: ["A"], D: ["B", "C"] }),
      baseDeps(runner, liveFactory),
      never,
    )
    expect(run.summary.ok).toBe(4)
    // A is first; D is last; B and C are after A and before D.
    expect(order[0]).toBe("A")
    expect(order[3]).toBe("D")
    expect(order.indexOf("B")).toBeGreaterThan(order.indexOf("A"))
    expect(order.indexOf("C")).toBeGreaterThan(order.indexOf("A"))
    expect(order.indexOf("D")).toBeGreaterThan(order.indexOf("B"))
    expect(order.indexOf("D")).toBeGreaterThan(order.indexOf("C"))
  })

  test("dead branch: A FAILS ⇒ B is blocked, NOT dispatched (transitive)", async () => {
    const { runner, order } = mkRunner(new Set(["A"]))
    const run = await runBatch(
      args(["A", "B", "C"], { B: ["A"], C: ["B"] }),
      baseDeps(runner, liveFactory),
      never,
    )
    expect(order).toEqual(["A"]) // only A ran; B and C never dispatched
    const byId = new Map(run.items.map((i) => [i.id, i]))
    expect(byId.get("A")?.status).toBe("error") // worker-failed
    expect(byId.get("B")?.status).toBe("error")
    expect(byId.get("B")?.error).toContain("dependency failed")
    expect(byId.get("C")?.status).toBe("error") // transitively blocked
    expect(byId.get("C")?.error).toContain("dependency failed")
    expect(run.summary.ok).toBe(0)
  })

  test("cyclic graph ⇒ the WHOLE batch is refused (nothing dispatched)", async () => {
    const { runner, order } = mkRunner()
    const run = await runBatch(
      args(["A", "B"], { A: ["B"], B: ["A"] }),
      baseDeps(runner, liveFactory),
      never,
    )
    expect(order).toEqual([]) // zero dispatch
    expect(run.summary.ok).toBe(0)
    expect(run.summary.failed).toBe(2)
    expect(run.items.every((i) => i.error?.startsWith("dag rejected"))).toBe(true)
  })

  test("dangling edge (dep id not in the batch) ⇒ refused", async () => {
    const { runner, order } = mkRunner()
    const run = await runBatch(args(["A"], { A: ["ghost"] }), baseDeps(runner, liveFactory), never)
    expect(order).toEqual([])
    expect(run.items[0]?.error).toContain("dag rejected")
  })

  test("no `dependencies` ⇒ flat fan-out (gate never engaged), all run", async () => {
    const { runner, order } = mkRunner()
    const run = await runBatch(args(["A", "B", "C"]), baseDeps(runner, liveFactory), never)
    expect(run.summary.ok).toBe(3)
    expect(order.sort()).toEqual(["A", "B", "C"]) // all ran (order unconstrained)
  })

  test("factory ABSENT (knob off) ⇒ deps ignored, flat fan-out (byte-identical)", async () => {
    const { runner, order } = mkRunner()
    // Same edges, but NO dagGateFactory wired ⇒ run-batch must NOT gate.
    const run = await runBatch(args(["A", "B"], { B: ["A"] }), baseDeps(runner), never)
    expect(run.summary.ok).toBe(2)
    expect(order.sort()).toEqual(["A", "B"]) // both ran; ordering not enforced
  })
})
