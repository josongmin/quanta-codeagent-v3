/** Hellgate — DagGate `markFailed` terminal-state guard (dag-gate.ts).
 *
 *  Round-1 audit gap: the existing dag tests cover the SYMMETRIC guard in
 *  `onComplete` (markComplete cannot resurrect a failed/cancelled node) but
 *  NOT the reverse: `markComplete(x)` then `markFailed(x)` on the SAME id.
 *
 *  The guard in dag-gate.ts#markFailed (mirroring onComplete's terminal guard)
 *  must keep a node that already reached a TERMINAL state from being flipped.
 *  Without it, a completion that already RELEASED dependents would be
 *  retroactively turned `failed` while its dependents (already dispatched)
 *  stay released — a graph inconsistency (a `failed` node whose dependents
 *  ran). This battery proves:
 *
 *    - completed → markFailed is a no-op: node stays out of `blocked()`.
 *    - a dependent already released by the completion stays READY (not blocked).
 *    - an awaiter that already resolved "ready" is never retroactively flipped.
 *    - the symmetric direction: failed → markComplete also stays dead
 *      (cross-check via the gate, not just the pure core).
 *    - cancelled is terminal too: completed → markFailed(x,"cancelled") no-op.
 *
 *  PURE — no clock, no I/O, no Date.now/Math.random. The only async is plain
 *  promise plumbing on the gate awaiters.
 */

import { describe, expect, test } from "bun:test"
import { createDagGate } from "@/subagent/coordination"
import type { TaskNode } from "@/subagent/coordination/dag"

const node = (
  id: string,
  dependsOn: readonly string[] = [],
  state: TaskNode["state"] = "pending",
): TaskNode => ({ id, dependsOn, state })

/** Unwrap a successful gate construction (the graphs here are all valid). */
const gateOf = (nodes: readonly TaskNode[]) => {
  const r = createDagGate(nodes)
  if (!r.ok) throw new Error(`expected valid gate, got rejection: ${r.reason}`)
  return r.gate
}

describe("DagGate.markFailed terminal-state guard — completed cannot flip to failed", () => {
  test("markComplete(a) then markFailed(a): a stays completed (not in blocked set)", () => {
    // a → b: b depends on a. Complete a (releases b), then try to fail a.
    const gate = gateOf([node("a"), node("b", ["a"])])
    gate.markComplete("a")
    // b is now ready (its only dep completed).
    expect(gate.ready().map((n) => n.id)).toContain("b")
    // Adversarial: a late markFailed on the already-completed node.
    gate.markFailed("a")
    // a must NOT appear blocked, and b must STILL be ready (dependent stays
    // released — never retroactively blocked).
    expect(gate.blocked().map((n) => n.id)).not.toContain("a")
    expect(gate.blocked().map((n) => n.id)).not.toContain("b")
    expect(gate.ready().map((n) => n.id)).toContain("b")
  })

  test("a dependent already released by completion is not flipped to blocked", () => {
    // a → b → c chain. Complete a then b (c becomes ready). Late-fail b.
    const gate = gateOf([node("a"), node("b", ["a"]), node("c", ["b"])])
    gate.markComplete("a")
    gate.markComplete("b")
    expect(gate.ready().map((n) => n.id)).toContain("c")
    gate.markFailed("b") // b is already completed — guarded no-op.
    // c stays ready; nothing newly blocked.
    expect(gate.ready().map((n) => n.id)).toContain("c")
    expect(gate.blocked()).toHaveLength(0)
  })

  test("an awaiter that resolved 'ready' is never retroactively flipped", async () => {
    const gate = gateOf([node("a"), node("b", ["a"])])
    // Register b's awaiter BEFORE a completes (it parks as a pending waiter).
    const bOutcome = gate.awaitReady("b")
    gate.markComplete("a") // resolves b's awaiter "ready"
    expect(await bOutcome).toBe("ready")
    // Late failure on a must not produce a NEW blocked resolution for b — a
    // second awaitReady("b") still resolves "ready" (b is ready, deps done).
    gate.markFailed("a")
    expect(await gate.awaitReady("b")).toBe("ready")
  })
})

describe("DagGate.markFailed terminal-state guard — cancelled is terminal too", () => {
  test("markComplete(a) then markFailed(a,'cancelled'): a stays completed", () => {
    const gate = gateOf([node("a"), node("b", ["a"])])
    gate.markComplete("a")
    gate.markFailed("a", "cancelled")
    expect(gate.blocked().map((n) => n.id)).not.toContain("b")
    expect(gate.ready().map((n) => n.id)).toContain("b")
  })
})

describe("DagGate symmetric direction — failed cannot flip to completed", () => {
  test("markFailed(a) then markComplete(a): a stays dead, dependent stays blocked", async () => {
    const gate = gateOf([node("a"), node("b", ["a"])])
    const bOutcome = gate.awaitReady("b")
    gate.markFailed("a") // b becomes a dead branch.
    expect(await bOutcome).toBe("blocked")
    expect(gate.blocked().map((n) => n.id)).toContain("b")
    // Adversarial: try to resurrect a — onComplete's guard refuses.
    gate.markComplete("a")
    // b must STAY blocked (a never became completed), and a re-await is blocked.
    expect(gate.blocked().map((n) => n.id)).toContain("b")
    expect(await gate.awaitReady("b")).toBe("blocked")
  })
})

describe("DagGate.markFailed — repeated late calls are idempotent no-ops", () => {
  test("two markFailed after a completion never change the ready/blocked sets", () => {
    const gate = gateOf([node("a"), node("b", ["a"])])
    gate.markComplete("a")
    const readyBefore = gate.ready().map((n) => n.id)
    const blockedBefore = gate.blocked().map((n) => n.id)
    gate.markFailed("a")
    gate.markFailed("a", "cancelled")
    expect(gate.ready().map((n) => n.id)).toEqual(readyBefore)
    expect(gate.blocked().map((n) => n.id)).toEqual(blockedBefore)
  })
})
