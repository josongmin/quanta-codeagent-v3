/**
 * Hellgate — multi-agent coordination Capability A: Task dependency DAG core.
 *
 * Drives the PURE core (`src/subagent/coordination/dag.ts`) — no I/O, no clock,
 * no LLM. The core is no-throw: every adversarial shape returns a typed value,
 * never an exception.
 *
 * Covers plan §2.A + §5 invariants:
 *   - cycle rejected (A→B→A) — a cyclic graph is NEVER dispatched.
 *   - unknown-dep edge rejected (typed).
 *   - linear chain releases in dependency order.
 *   - diamond A→{B,C}→D — D waits for BOTH B and C.
 *   - failed/cancelled dep ⇒ dependent is `blocked`, not ready (no hang).
 *   - empty + single-node graphs.
 *   - onComplete returns EXACTLY the newly-unblocked set.
 *   - readyTasks deterministic (byteCompare) order.
 */
import { describe, expect, test } from "bun:test"
import {
  blockedTasks,
  detectCycle,
  onComplete,
  readyTasks,
  type TaskNode,
} from "../../../src/subagent/coordination/dag"

const node = (
  id: string,
  dependsOn: readonly string[] = [],
  state: TaskNode["state"] = "pending",
): TaskNode => ({ id, dependsOn, state })

describe("DAG core — detectCycle", () => {
  test("empty graph is acyclic", () => {
    expect(detectCycle([])).toEqual({ ok: true })
  })

  test("single node with no deps is acyclic", () => {
    expect(detectCycle([node("a")])).toEqual({ ok: true })
  })

  test("single self-loop A→A is a cycle", () => {
    const r = detectCycle([node("a", ["a"])])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.cycle).toContain("a")
  })

  test("two-node cycle A→B→A is rejected with the cycle path", () => {
    const r = detectCycle([node("a", ["b"]), node("b", ["a"])])
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.cycle).toContain("a")
      expect(r.cycle).toContain("b")
    }
  })

  test("three-node cycle A→B→C→A is rejected", () => {
    const r = detectCycle([node("a", ["b"]), node("b", ["c"]), node("c", ["a"])])
    expect(r.ok).toBe(false)
  })

  test("linear chain A→B→C is acyclic", () => {
    expect(detectCycle([node("a"), node("b", ["a"]), node("c", ["b"])])).toEqual({ ok: true })
  })

  test("diamond A→{B,C}→D is acyclic", () => {
    const r = detectCycle([node("a"), node("b", ["a"]), node("c", ["a"]), node("d", ["b", "c"])])
    expect(r).toEqual({ ok: true })
  })

  test("edge to an unknown id is rejected (typed, no throw)", () => {
    const r = detectCycle([node("a", ["ghost"])])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.cycle).toContain("ghost")
  })

  test("duplicate node ids are rejected (ambiguous graph)", () => {
    const r = detectCycle([node("a"), node("a")])
    expect(r.ok).toBe(false)
  })
})

describe("DAG core — readyTasks", () => {
  test("empty graph ⇒ no ready tasks", () => {
    expect(readyTasks([])).toEqual([])
  })

  test("single pending root is ready", () => {
    expect(readyTasks([node("a")]).map((n) => n.id)).toEqual(["a"])
  })

  test("linear chain: only the root is ready until its dep completes", () => {
    const nodes = [node("c", ["b"]), node("b", ["a"]), node("a")]
    expect(readyTasks(nodes).map((n) => n.id)).toEqual(["a"])
  })

  test("a pending node with all deps completed is ready", () => {
    const nodes = [node("a", [], "completed"), node("b", ["a"])]
    expect(readyTasks(nodes).map((n) => n.id)).toEqual(["b"])
  })

  test("a node with one completed + one pending dep is NOT ready", () => {
    const nodes = [node("a", [], "completed"), node("b"), node("c", ["a", "b"])]
    expect(readyTasks(nodes).map((n) => n.id)).toEqual(["b"])
  })

  test("already-running / completed nodes are never re-listed as ready", () => {
    const nodes = [node("a", [], "completed"), node("b", [], "in_progress"), node("c")]
    expect(readyTasks(nodes).map((n) => n.id)).toEqual(["c"])
  })

  test("ready order is deterministic byteCompare, NOT input order", () => {
    const nodes = [node("z"), node("m"), node("a")]
    expect(readyTasks(nodes).map((n) => n.id)).toEqual(["a", "m", "z"])
  })

  test("diamond: B and C both ready after A completes; D still blocked", () => {
    const nodes = [
      node("a", [], "completed"),
      node("b", ["a"]),
      node("c", ["a"]),
      node("d", ["b", "c"]),
    ]
    expect(readyTasks(nodes).map((n) => n.id)).toEqual(["b", "c"])
  })
})

describe("DAG core — blockedTasks (dead-branch surfacing, no hang)", () => {
  test("a pending node with a FAILED dep is blocked, not ready", () => {
    const nodes = [node("a", [], "failed"), node("b", ["a"])]
    expect(readyTasks(nodes).map((n) => n.id)).toEqual([])
    expect(blockedTasks(nodes).map((n) => n.id)).toEqual(["b"])
  })

  test("a pending node with a CANCELLED dep is blocked, not ready", () => {
    const nodes = [node("a", [], "cancelled"), node("b", ["a"])]
    expect(readyTasks(nodes).map((n) => n.id)).toEqual([])
    expect(blockedTasks(nodes).map((n) => n.id)).toEqual(["b"])
  })

  test("transitive dead branch: B blocked by failed A, C blocked by B", () => {
    const nodes = [node("a", [], "failed"), node("b", ["a"]), node("c", ["b"])]
    const blocked = blockedTasks(nodes).map((n) => n.id)
    expect(blocked).toContain("b")
    expect(blocked).toContain("c")
    expect(readyTasks(nodes)).toEqual([])
  })

  test("a node with a completed dep is NOT blocked", () => {
    const nodes = [node("a", [], "completed"), node("b", ["a"])]
    expect(blockedTasks(nodes)).toEqual([])
  })

  test("blocked order is deterministic byteCompare", () => {
    const nodes = [node("x", [], "failed"), node("z", ["x"]), node("a", ["x"])]
    expect(blockedTasks(nodes).map((n) => n.id)).toEqual(["a", "z"])
  })

  test("a node is never simultaneously ready and blocked", () => {
    const nodes = [node("a", [], "completed"), node("f", [], "failed"), node("b", ["a", "f"])]
    expect(readyTasks(nodes)).toEqual([])
    expect(blockedTasks(nodes).map((n) => n.id)).toEqual(["b"])
  })
})

describe("DAG core — onComplete (release dependents)", () => {
  test("completing the root unblocks exactly its direct dependents", () => {
    const nodes = [node("a"), node("b", ["a"]), node("c", ["a"]), node("d", ["b"])]
    const r = onComplete(nodes, "a")
    expect(r.newlyReady.map((n) => n.id)).toEqual(["b", "c"])
    // D is NOT newly ready (b still pending).
    expect(r.newlyReady.map((n) => n.id)).not.toContain("d")
    // The returned nodes mark a as completed.
    expect(r.nodes.find((n) => n.id === "a")?.state).toBe("completed")
  })

  test("completing a node whose dependent has another pending dep yields nothing", () => {
    const nodes = [node("a"), node("b"), node("c", ["a", "b"])]
    const r = onComplete(nodes, "a")
    expect(r.newlyReady).toEqual([])
    // Now complete b on the updated set ⇒ c releases.
    const r2 = onComplete(r.nodes, "b")
    expect(r2.newlyReady.map((n) => n.id)).toEqual(["c"])
  })

  test("completing an unknown id is a no-op (no throw, nothing newly ready)", () => {
    const nodes = [node("a"), node("b", ["a"])]
    const r = onComplete(nodes, "ghost")
    expect(r.newlyReady).toEqual([])
    expect(r.nodes).toEqual(nodes)
  })

  test("completing an already-completed node releases nothing new", () => {
    const nodes = [node("a", [], "completed"), node("b", ["a"])]
    // b is already ready in this set; completing a again must not "re-release" b.
    const r = onComplete(nodes, "a")
    expect(r.newlyReady).toEqual([])
  })

  test("diamond fan-in: D releases only after BOTH B and C complete", () => {
    let nodes: readonly TaskNode[] = [
      node("a", [], "completed"),
      node("b", ["a"]),
      node("c", ["a"]),
      node("d", ["b", "c"]),
    ]
    const afterB = onComplete(nodes, "b")
    expect(afterB.newlyReady).toEqual([])
    nodes = afterB.nodes
    const afterC = onComplete(nodes, "c")
    expect(afterC.newlyReady.map((n) => n.id)).toEqual(["d"])
  })

  test("newlyReady is deterministic byteCompare order", () => {
    const nodes = [node("a"), node("z", ["a"]), node("b", ["a"]), node("m", ["a"])]
    const r = onComplete(nodes, "a")
    expect(r.newlyReady.map((n) => n.id)).toEqual(["b", "m", "z"])
  })

  // Audit #2 regression: a dead branch must STAY dead. onComplete must NEVER
  // resurrect a terminal-FAILURE node into `completed` (which would silently
  // re-arm its dependents). The gate calls markComplete only on pending workers,
  // but markComplete(id) is a public method callable on ANY id.
  test("does NOT resurrect a `failed` node (no transition, no newlyReady)", () => {
    const nodes = [node("a", [], "failed"), node("b", ["a"])]
    const r = onComplete(nodes, "a")
    expect(r.nodes.find((n) => n.id === "a")?.state).toBe("failed") // stays dead
    expect(r.newlyReady).toEqual([]) // b NOT released
    // b is still on the dead branch.
    expect(blockedTasks(r.nodes).map((n) => n.id)).toEqual(["b"])
  })

  test("does NOT resurrect a `cancelled` node", () => {
    const nodes = [node("a", [], "cancelled"), node("b", ["a"])]
    const r = onComplete(nodes, "a")
    expect(r.nodes.find((n) => n.id === "a")?.state).toBe("cancelled")
    expect(r.newlyReady).toEqual([])
  })
})

// Audit #1 regression: blockedTasks must give the CORRECT dead set even on a
// graph carrying a cycle (the function's own contract says it may be called on a
// graph that was NOT cycle-checked). The old recursive memo poisoned a `false`
// for a node whose only dead path ran through a still-`visiting` cycle member.
// The monotone-fixpoint implementation is cycle-safe by construction.
describe("DAG core — blockedTasks on a CYCLIC graph (memo-poison regression)", () => {
  test("X↔Y cycle where Y also depends on a cancelled node ⇒ X, Y, Z all blocked", () => {
    // Dead(cancelled); X→[Y]; Y→[X, Dead]; Z→[X]. Ground truth: all of X,Y,Z are
    // transitively dead (Y via Dead; X via Y; Z via X). The old code returned
    // only ["Y"] — X and Z were wrongly reported not-blocked.
    const nodes = [
      node("Y", ["X", "Dead"]),
      node("X", ["Y"]),
      node("Z", ["X"]),
      node("Dead", [], "cancelled"),
    ]
    expect(blockedTasks(nodes).map((n) => n.id)).toEqual(["X", "Y", "Z"])
  })

  test("a pure cycle with NO dead member blocks nothing (terminates, no false-dead)", () => {
    const nodes = [node("a", ["b"]), node("b", ["a"])]
    expect(blockedTasks(nodes)).toEqual([])
  })

  test("a long chain does not overflow the stack (fixpoint is iterative)", () => {
    const N = 5000
    const nodes: TaskNode[] = [node("n0", [], "failed")]
    for (let i = 1; i < N; i++) nodes.push(node(`n${i}`, [`n${i - 1}`]))
    // Every node after the failed root is transitively blocked.
    expect(blockedTasks(nodes).length).toBe(N - 1)
  })
})
